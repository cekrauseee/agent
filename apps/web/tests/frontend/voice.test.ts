import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { RECORDING_LIMIT, VoiceRecorder } from '../../lib/client/conversation/voice'

const draft = { text: 'Before [replace] after', selectionStart: 7, selectionEnd: 16 }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup(t: TestContext) {
  const counts = { stopped: 0, closed: 0, framesCancelled: 0, requests: 0 }
  const track = { onended: null as (() => void) | null, stop: () => ++counts.stopped }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  let permission: () => Promise<unknown> = async () => stream
  let audioResume: () => Promise<void> = async () => {}
  let supported = 'audio/webm'
  let frame: ((time: number) => void) | null = null
  const recorders: FakeRecorder[] = []
  class FakeRecorder {
    static isTypeSupported(mime: string) {
      return mime.startsWith(supported) && supported !== ''
    }
    state = 'inactive'
    mimeType: string
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    chunks = [new Blob([new Uint8Array(24)])]
    constructor(_stream: unknown, options: { mimeType: string }) {
      this.mimeType = options.mimeType
      recorders.push(this)
    }
    start(timeslice: number) {
      assert.equal(timeslice, 250)
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.chunks.forEach((data) => this.ondataavailable?.({ data }))
      queueMicrotask(() => this.onstop?.())
    }
  }
  class FakeAudio {
    resume() {
      return audioResume()
    }
    close() {
      ++counts.closed
      return Promise.resolve()
    }
    createAnalyser() {
      return {
        fftSize: 256,
        getByteTimeDomainData: (samples: Uint8Array) => samples.fill(192),
      }
    }
    createMediaStreamSource() {
      return { connect: () => {} }
    }
  }
  const globals = {
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: unknown) => {
          assert.deepEqual(constraints, { audio: true })
          ++counts.requests
          return permission()
        },
      },
    },
    MediaRecorder: FakeRecorder,
    AudioContext: FakeAudio,
    requestAnimationFrame: (callback: (time: number) => void) => {
      frame = callback
      return 1
    },
    cancelAnimationFrame: () => ++counts.framesCancelled,
  }
  const restore: (() => void)[] = []
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    restore.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  const edits: string[] = []
  const sends: string[] = []
  const uploads: { audio: Blob; filename: string; signal?: AbortSignal }[] = []
  let transcript: () => Promise<string> = async () => 'speech'
  let send: () => Promise<void> = async () => {}
  const recorder = new VoiceRecorder({
    onValueChange: (text) => edits.push(text),
    onSubmit: async (text) => {
      sends.push(text)
      await send()
    },
    transcribeRecording: async (audio, filename, signal) => {
      uploads.push({ audio, filename, signal })
      return transcript()
    },
  })
  t.after(() => {
    recorder.dispose()
    restore.forEach((restoreGlobal) => restoreGlobal())
  })
  return {
    recorder,
    recorders,
    track,
    counts,
    edits,
    sends,
    uploads,
    permission: (value: typeof permission) => (permission = value),
    resume: (value: typeof audioResume) => (audioResume = value),
    transcript: (value: typeof transcript) => (transcript = value),
    send: (value: typeof send) => (send = value),
    supported: (value: string) => (supported = value),
    frame: () => frame?.(100),
  }
}

test('stop inserts at saved selection without sending; send uses combined draft once', async (t) => {
  const h = setup(t)
  await h.recorder.start(draft)
  h.frame()
  assert.ok(h.recorder.getSnapshot().waveform.startsWith('0,29'))
  const lateError = h.recorders[0].onerror!
  h.recorder.finish('insert')
  h.recorder.finish('send')
  await tick()
  lateError()
  h.frame()
  assert.equal(h.recorder.getSnapshot().error, null)
  assert.equal(h.recorder.getSnapshot().waveform, '')
  assert.deepEqual(h.edits, ['Before speech after'])
  assert.deepEqual(h.sends, [])
  assert.equal(h.uploads.length, 1)
  assert.equal(h.uploads[0].filename, 'recording.webm')
  assert.equal(h.uploads[0].audio.type, 'audio/webm')
  assert.ok(h.counts.closed && h.counts.stopped && h.counts.framesCancelled)
  await h.recorder.start({ ...draft, selectionStart: null, selectionEnd: null })
  h.recorder.finish('send')
  h.recorder.finish('send')
  await tick()
  assert.deepEqual(h.sends, ['Before [replace] afterspeech'])
  assert.equal(h.uploads.length, 2)
  assert.equal(h.recorder.getSnapshot().phase, 'idle')
})

test('cancel discards without transcription/send and ignores late microphone permission', async (t) => {
  const h = setup(t)
  await h.recorder.start(draft)
  h.recorder.cancel()
  assert.equal(h.counts.stopped, 1)
  assert.deepEqual(h.edits, [])
  assert.deepEqual(h.uploads, [])
  assert.deepEqual(h.sends, [])
  let grant: (stream: unknown) => void = () => {}
  h.permission(() => new Promise((resolve) => (grant = resolve)))
  const pending = h.recorder.start(draft)
  h.recorder.cancel()
  grant({ getTracks: () => [h.track] })
  await pending
  assert.equal(h.counts.stopped, 2)
  assert.equal(h.recorder.getSnapshot().phase, 'idle')
  assert.deepEqual(h.uploads, [])
})

test('teardown during Web Audio startup releases media and ignores resumed context', async (t) => {
  const h = setup(t)
  let resume: () => void = () => {}
  h.resume(() => new Promise((resolve) => (resume = resolve)))
  const pending = h.recorder.start(draft)
  await tick()
  h.recorder.dispose()
  resume()
  await pending
  assert.equal(h.recorders.length, 0)
  assert.equal(h.counts.stopped, 1)
  assert.equal(h.counts.closed, 1)
})

test('cancel and route teardown abort uploads and invalidate late transcription results', async (t) => {
  const h = setup(t)
  let resolve: (value: string) => void = () => {}
  h.transcript(() => new Promise((done) => (resolve = done)))
  await h.recorder.start(draft)
  h.recorder.finish('send')
  await tick()
  h.recorder.cancel()
  assert.equal(h.uploads[0].signal?.aborted, true)
  resolve('late')
  await tick()
  assert.deepEqual(h.edits, [])
  assert.deepEqual(h.sends, [])
  await h.recorder.start(draft)
  h.recorder.finish('send')
  await tick()
  h.recorder.dispose()
  assert.equal(h.uploads[1].signal?.aborted, true)
  resolve('another late result')
  await tick()
  assert.deepEqual(h.edits, [])
  assert.deepEqual(h.sends, [])
})

test('blank/failed transcription preserves text; failed send preserves the combined text', async (t) => {
  const h = setup(t)
  for (const transcript of [
    async () => ' \n ',
    async () => Promise.reject(new Error('provider')),
  ]) {
    h.transcript(transcript)
    await h.recorder.start(draft)
    h.recorder.finish('send')
    await tick()
    assert.ok(h.recorder.getSnapshot().error)
  }
  assert.deepEqual(h.edits, [])
  assert.deepEqual(h.sends, [])
  h.transcript(async () => 'speech')
  h.send(async () => {
    throw new Error('admission failed')
  })
  await h.recorder.start(draft)
  h.recorder.finish('send')
  await tick()
  assert.deepEqual(h.edits, ['Before speech after'])
  assert.deepEqual(h.sends, ['Before speech after'])
  assert.match(h.recorder.getSnapshot().error ?? '', /transcribed draft is preserved/)
})

test('MP4 is supported, unknown format/empty audio/size limit never uploads', async (t) => {
  const h = setup(t)
  h.supported('audio/mp4')
  await h.recorder.start(draft)
  h.recorder.finish('insert')
  await tick()
  assert.equal(h.uploads[0].filename, 'recording.mp4')
  assert.equal(h.uploads[0].audio.type, 'audio/mp4')
  await h.recorder.start(draft)
  h.recorders.at(-1)!.mimeType = 'audio/ogg'
  h.recorder.finish('send')
  await tick()
  assert.match(h.recorder.getSnapshot().error ?? '', /unsupported/)
  await h.recorder.start(draft)
  h.recorders.at(-1)!.chunks = []
  h.recorder.finish('send')
  await tick()
  assert.match(h.recorder.getSnapshot().error ?? '', /No audio/)
  await h.recorder.start(draft)
  h.recorders.at(-1)!.ondataavailable?.({ data: new Blob([new Uint8Array(RECORDING_LIMIT + 1)]) })
  h.recorder.finish('send')
  await tick()
  assert.match(h.recorder.getSnapshot().error ?? '', /too large/)
  assert.equal(h.uploads.length, 1)
  assert.equal(h.sends.length, 0)
  assert.ok(RECORDING_LIMIT + 10_000 < 4_000_000)
})

test('unsupported capture, denied access, missing device, and interruptions are recoverable', async (t) => {
  const h = setup(t)
  h.supported('')
  await h.recorder.start(draft)
  assert.match(h.recorder.getSnapshot().error ?? '', /supported WebM or MP4/)
  assert.equal(h.counts.requests, 0)
  h.supported('audio/webm')
  for (const [name, message] of [
    ['NotAllowedError', /denied/],
    ['NotFoundError', /No microphone/],
    ['NotReadableError', /Could not start/],
  ] as const) {
    h.permission(async () => {
      const error = new Error(name)
      error.name = name
      throw error
    })
    await h.recorder.start(draft)
    assert.match(h.recorder.getSnapshot().error ?? '', message)
  }
  h.permission(async () => ({ getTracks: () => [h.track], getAudioTracks: () => [h.track] }))
  await h.recorder.start(draft)
  const lateError = h.recorders.at(-1)!.onerror!
  h.track.onended?.()
  assert.match(h.recorder.getSnapshot().error ?? '', /disconnected/)
  await h.recorder.start(draft)
  lateError()
  assert.equal(h.recorder.getSnapshot().phase, 'recording')
  assert.equal(h.uploads.length, 0)
  assert.equal(h.sends.length, 0)
  h.recorder.cancel()
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: undefined })
  await h.recorder.start(draft)
  assert.match(h.recorder.getSnapshot().error ?? '', /unavailable in this browser/)
})

test('five-minute safety limit discards safely without uploading', async (t) => {
  const h = setup(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await h.recorder.start(draft)
  t.mock.timers.tick(5 * 60_000)
  assert.equal(h.recorder.getSnapshot().phase, 'idle')
  assert.match(h.recorder.getSnapshot().error ?? '', /time limit/)
  assert.equal(h.uploads.length, 0)
  assert.equal(h.sends.length, 0)
  assert.equal(h.counts.stopped, 1)
})
