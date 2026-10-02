import { ConversationProviders } from '@/components/conversation/conversation-providers'

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <ConversationProviders>{children}</ConversationProviders>
}
