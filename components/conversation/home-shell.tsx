'use client'

import Link from 'next/link'
import { useRef, type ReactNode } from 'react'
import type { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import {
  BotIcon,
  HomeIcon,
  LogOutIcon,
  PanelLeftCloseIcon,
  PinIcon,
  PlusIcon,
  UserIcon,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ConversationState, Profile } from '@/lib/client/conversation/types'

export type HomeNavigationState = Pick<
  ConversationState,
  | 'profile'
  | 'conversations'
  | 'listLoading'
  | 'listError'
  | 'refreshConversations'
  | 'logout'
  | 'startNewConversation'
>

export function profileDisplayName(profile: Profile) {
  return (
    [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ') || profile.email
  )
}

export function HomeShell({
  children,
  navigation,
  conversationId,
}: {
  children: ReactNode
  navigation: HomeNavigationState
  conversationId: string | null
}) {
  return (
    <SidebarProvider className='h-svh min-h-0'>
      <HomeNavigation navigation={navigation} conversationId={conversationId} />
      <SidebarInset
        id='conversation-content'
        tabIndex={-1}
        className='min-h-0 min-w-0 overflow-hidden'
      >
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}

function ProfileAvatar({ profile }: { profile: Profile }) {
  return (
    <Avatar>
      {profile.image && <AvatarImage src={profile.image} alt='' />}
      <AvatarFallback>
        <UserIcon aria-hidden='true' />
      </AvatarFallback>
    </Avatar>
  )
}

function AccountMenu({ navigation }: { navigation: HomeNavigationState }) {
  const profile = navigation.profile
  if (!profile) return <Skeleton className='size-8' aria-label='Loading account' />
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant='ghost' size='icon-lg' />}
        aria-label='Account menu'
      >
        <ProfileAvatar profile={profile} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side='right' align='end' className='w-72 max-w-[calc(100vw-4rem)]'>
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className='flex items-center gap-3'>
              <ProfileAvatar profile={profile} />
              <div className='flex min-w-0 flex-col gap-1'>
                <span className='break-words'>{profileDisplayName(profile)}</span>
                <span className='break-all'>{profile.email}</span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void navigation.logout()}>
            <LogOutIcon aria-hidden='true' />
            Log out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HomeNavigation({
  navigation,
  conversationId,
}: {
  navigation: HomeNavigationState
  conversationId: string | null
}) {
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar()
  const previewActionsRef = useRef<PopoverPrimitive.Root.Actions>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const homeRef = useRef<HTMLElement>(null)
  const closeNavigation = () => {
    previewActionsRef.current?.close()
    setOpenMobile(false)
  }
  const panel = (preview: boolean) => (
    <ConversationSidebar
      navigation={navigation}
      conversationId={conversationId}
      preview={preview}
      onNavigate={closeNavigation}
      onToggle={() => {
        if (isMobile) setOpenMobile(false)
        else setOpen(!open)
        previewActionsRef.current?.close()
        requestAnimationFrame(() => homeRef.current?.focus())
      }}
    />
  )
  return (
    <>
      <Button
        render={<a href='#conversation-content' />}
        nativeButton={false}
        role='link'
        className='sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:p-3'
      >
        Skip to content
      </Button>
      <Sidebar
        collapsible='none'
        className='sticky top-0 h-svh w-14 shrink-0'
        role='navigation'
        aria-label='Application navigation'
      >
        <SidebarHeader className='items-center'>
          {!open && !isMobile ? (
            <Popover
              actionsRef={previewActionsRef}
              onOpenChange={(nextOpen, details) => {
                if (
                  !nextOpen &&
                  details.reason === 'trigger-hover' &&
                  previewRef.current?.contains(document.activeElement)
                ) {
                  details.cancel()
                  return
                }
              }}
            >
              <PopoverTrigger
                ref={(element) => {
                  homeRef.current = element
                }}
                render={<Button variant='ghost' size='icon-lg' />}
                aria-label='Home'
                openOnHover
                delay={0}
                closeDelay={150}
              >
                <HomeIcon aria-hidden='true' />
              </PopoverTrigger>
              <PopoverContent
                ref={previewRef}
                side='right'
                align='start'
                sideOffset={8}
                className='h-[calc(100svh-1rem)] max-h-(--available-height) w-64 max-w-(--available-width) overflow-hidden'
                initialFocus={(interaction) => (interaction === 'mouse' ? false : true)}
              >
                <PopoverTitle className='sr-only'>Home navigation</PopoverTitle>
                {panel(true)}
              </PopoverContent>
            </Popover>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  isMobile ? (
                    <Button
                      ref={(element) => {
                        homeRef.current = element
                      }}
                      variant='ghost'
                      size='icon-lg'
                    />
                  ) : (
                    <Button
                      nativeButton={false}
                      role='link'
                      variant='ghost'
                      size='icon-lg'
                      render={
                        <Link
                          href='/'
                          ref={(element) => {
                            homeRef.current = element
                          }}
                        />
                      }
                    />
                  )
                }
                aria-label='Home'
                aria-expanded={isMobile ? openMobile : undefined}
                onClick={() => {
                  if (isMobile) setOpenMobile(!openMobile)
                }}
              >
                <HomeIcon aria-hidden='true' />
              </TooltipTrigger>
              <TooltipContent side='right'>Home</TooltipContent>
            </Tooltip>
          )}
        </SidebarHeader>
        <SidebarFooter className='mt-auto items-center'>
          <AccountMenu navigation={navigation} />
        </SidebarFooter>
      </Sidebar>
      {(open || isMobile) && <Sidebar className='left-14!'>{panel(false)}</Sidebar>}
    </>
  )
}

function ConversationSidebar({
  navigation,
  conversationId,
  preview,
  onToggle,
  onNavigate,
}: {
  navigation: HomeNavigationState
  conversationId: string | null
  preview: boolean
  onToggle: () => void
  onNavigate: () => void
}) {
  return (
    <nav aria-label='Home navigation' className='flex min-h-0 flex-1 flex-col'>
      <SidebarHeader>
        <div className='flex items-center justify-between gap-2'>
          <span className='flex items-center gap-2'>
            <BotIcon aria-hidden='true' className='size-5' />
            Agent
          </span>
          <Button
            variant='ghost'
            size='icon-lg'
            aria-label={preview ? 'Pin sidebar' : 'Close sidebar'}
            onClick={onToggle}
          >
            {preview ? <PinIcon aria-hidden='true' /> : <PanelLeftCloseIcon aria-hidden='true' />}
          </Button>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  href='/'
                  onNavigate={() => {
                    navigation.startNewConversation()
                    onNavigate()
                  }}
                />
              }
            >
              <PlusIcon aria-hidden='true' />
              <span>New Conversation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Conversations</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label='Conversations' aria-busy={navigation.listLoading}>
              <SidebarMenu>
                {navigation.conversations.map((conversation) => (
                  <SidebarMenuItem key={conversation.id}>
                    <SidebarMenuButton
                      isActive={conversation.id === conversationId}
                      render={
                        <Link
                          href={`/conversation/${encodeURIComponent(conversation.id)}`}
                          onNavigate={onNavigate}
                        />
                      }
                      aria-current={conversation.id === conversationId ? 'page' : undefined}
                      title={conversation.title || 'Untitled conversation'}
                    >
                      <span>{conversation.title || 'Untitled conversation'}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {navigation.listLoading && (
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton />
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </nav>
            {navigation.listError && (
              <Alert>
                <AlertTitle>Conversations unavailable</AlertTitle>
                <AlertDescription>
                  {navigation.listError.message}
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={navigation.listLoading}
                    onClick={() => void navigation.refreshConversations()}
                  >
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {!navigation.listLoading &&
              !navigation.listError &&
              !navigation.conversations.length && (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No conversations yet</EmptyTitle>
                    <EmptyDescription>Start a new conversation.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  )
}
