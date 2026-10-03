import { ConversationScreen } from '@/components/conversation/conversation-screen'

export default async function ConversationPage({ params }: PageProps<'/conversation/[id]'>) {
  const { id } = await params
  return <ConversationScreen conversationId={id} />
}
