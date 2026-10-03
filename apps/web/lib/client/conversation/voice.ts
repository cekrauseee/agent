import { insertTranscript, type RecordingDraft } from './composer'

// Leave 100 kB for the browser's multipart boundary and headers.
export const RECORDING_LIMIT = 3_900_000
const FORMATS = [
  { mime: 'audio/webm;codecs=opus', type: 'audio/webm', extension: 'webm' },
  { mime: 'audio/webm', type: 'audio/webm', extension: 'webm' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', type: 'audio/mp4', extension: 'mp4' },
  { mime: 'audio/mp4', type: 'audio/mp4', extension: 'mp4' },
] as const

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'submitting'
export type VoiceState = { phase: Phase; error: string | null; waveform: string }
type Outcome = 'insert' | 'send'
type Callbacks = {
  onValueChange: (text: string) => void
  onSubmit: (text: string) => Promise<unknown>
  transcribeRecording: (audio: Blob, filename: string, signal?: AbortSignal) => Promise<string>
}

/** Owns one local recording; no audio or transcript enters shared state before completion. */
export class VoiceRecorder {
  private state: VoiceState = { phase: 'idle', error: null, waveform: '' }
  private listeners = new Set<() => void>()
  private epoch = 0
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private audio: AudioContext | null = null
  private frame: number | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private upload: AbortController | null = null
  private chunks: Blob[] = []
  private bytes = 0
  private draft: RecordingDraft | null = null

  constructor(private callbacks: Callbacks) {}

  setCallbacks(callbacks: Callbacks) {
    this.callbacks = callbacks
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(next: Partial<VoiceState>) {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((listener) => listener())
  }

  clearError = () => this.update({ error: null })

  private release() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    if (this.recorder) {
      this.recorder.ondataavailable = null
      this.recorder.onstop = null
      this.recorder.onerror = null
      if (this.recorder.state !== 'inactive') this.recorder.stop()
    }
    this.recorder = null
    this.stream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    this.stream = null
    if (this.audio) void this.audio.close().catch(() => {})
    this.audio = null
    this.upload?.abort()
    this.upload = null
    this.chunks = []
    this.bytes = 0
    this.draft = null
  }

  cancel = () => {
    ++this.epoch
    this.release()
    this.update({ phase: 'idle', waveform: '', error: null })
  }

  dispose = () => {
    ++this.epoch
    this.release()
  }

  private fail(error: string) {
    ++this.epoch
    this.release()
    this.update({ phase: 'idle', waveform: '', error })
  }

  start = async (draft: RecordingDraft) => {
    if (this.state.phase !== 'idle') return
    this.update({ phase: 'requesting', error: null, waveform: '' })
    const epoch = ++this.epoch
    this.draft = { ...draft }
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined' ||
      typeof MediaRecorder.isTypeSupported !== 'function' ||
      typeof AudioContext === 'undefined'
    ) {
      this.fail('Recording is unavailable in this browser. Use a supported browser over HTTPS.')
      return
    }
    const format = FORMATS.find(({ mime }) => MediaRecorder.isTypeSupported(mime))
    if (!format) {
      this.fail('This browser cannot record a supported WebM or MP4 audio format.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (epoch !== this.epoch) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.stream = stream
      if (!stream.getAudioTracks().length) {
        this.fail('No microphone audio track was found. Connect a microphone and try again.')
        return
      }
      this.audio = new AudioContext()
      await this.audio.resume()
      if (epoch !== this.epoch) return
      const analyser = this.audio.createAnalyser()
      analyser.fftSize = 256
      this.audio.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      let lastDraw = 0
      const draw = (time: number) => {
        if (epoch !== this.epoch || this.state.phase !== 'recording') return
        if (time - lastDraw >= 100) {
          analyser.getByteTimeDomainData(samples)
          const waveform = Array.from(
            samples,
            (sample, index) =>
              `${(index * 200) / (samples.length - 1)},${20 + ((sample - 128) / 128) * 18}`,
          ).join(' ')
          this.update({ waveform })
          lastDraw = time
        }
        this.frame = requestAnimationFrame(draw)
      }
      this.recorder = new MediaRecorder(stream, {
        mimeType: format.mime,
        audioBitsPerSecond: 64_000,
      })
      const recorder = this.recorder
      recorder.ondataavailable = ({ data }) => {
        if (epoch !== this.epoch || this.recorder !== recorder || !data.size) return
        this.bytes += data.size
        if (this.bytes > RECORDING_LIMIT) {
          this.fail('Recording is too large. Your draft is preserved. Record a shorter message.')
          return
        }
        this.chunks.push(data)
      }
      recorder.onerror = () => {
        if (epoch === this.epoch && this.recorder === recorder)
          this.fail('Recording was interrupted. Your draft is preserved.')
      }
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (epoch === this.epoch && this.stream === stream)
            this.fail('Microphone disconnected. Your draft is preserved.')
        }
      })
      recorder.onstop = () => {
        if (epoch === this.epoch && this.state.phase === 'recording')
          this.fail('Recording was interrupted. Your draft is preserved.')
      }
      recorder.start(250)
      this.timeout = setTimeout(
        () =>
          this.fail('Recording reached the time limit. Record a message shorter than 5 minutes.'),
        5 * 60_000,
      )
      this.update({ phase: 'recording' })
      this.frame = requestAnimationFrame(draw)
    } catch (error) {
      if (epoch !== this.epoch) return
      const name = error instanceof Error ? error.name : ''
      this.fail(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was denied. Allow microphone access and try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Connect a microphone and try again.'
            : 'Could not start recording. Check your microphone and try again.',
      )
    }
  }

  finish = (outcome: Outcome) => {
    if (this.state.phase !== 'recording' || !this.recorder || !this.draft) return
    const epoch = this.epoch
    const recorder = this.recorder
    const draft = this.draft
    this.update({ phase: 'transcribing' })
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    recorder.onstop = () => {
      if (epoch !== this.epoch) return
      const type = recorder.mimeType.split(';')[0].trim().toLowerCase()
      const format = FORMATS.find((format) => format.type === type)
      if (!format) {
        this.fail('The browser returned an unsupported recording format.')
        return
      }
      const blob = new Blob(this.chunks, { type: format.type })
      this.release()
      if (blob.size < 12) {
        this.fail('No audio was recorded. Your draft is preserved. Try again.')
        return
      }
      void this.transcribe(blob, format.extension, draft, outcome, epoch)
    }
    try {
      recorder.stop()
    } catch {
      this.fail('Could not finalize recording. Your draft is preserved. Try again.')
    }
  }

  private async transcribe(
    blob: Blob,
    extension: string,
    draft: RecordingDraft,
    outcome: Outcome,
    epoch: number,
  ) {
    this.upload = new AbortController()
    try {
      const transcript = await this.callbacks.transcribeRecording(
        blob,
        `recording.${extension}`,
        this.upload.signal,
      )
      if (epoch !== this.epoch) return
      if (typeof transcript !== 'string' || !transcript.trim()) {
        this.fail('No speech was transcribed. Your draft is preserved. Try again.')
        return
      }
      const combined = insertTranscript(draft, transcript)
      this.callbacks.onValueChange(combined)
      if (outcome === 'send') {
        this.update({ phase: 'submitting' })
        await this.callbacks.onSubmit(combined)
      }
      if (epoch === this.epoch) {
        this.upload = null
        this.update({ phase: 'idle', waveform: '' })
      }
    } catch {
      if (epoch === this.epoch)
        this.fail(
          this.state.phase === 'submitting'
            ? 'Could not send the message. Your transcribed draft is preserved. Try again.'
            : 'Could not transcribe recording. Your draft is preserved. Try again.',
        )
    }
  }
}
