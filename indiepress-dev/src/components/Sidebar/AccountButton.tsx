import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { toSettings, toWallet } from '@/lib/link'
import { formatPubkey, generateImageByPubkey } from '@/lib/pubkey'
import { cn } from '@/lib/utils'
import { usePrimaryPage, useSecondaryPage } from '@/PageManager'
import { useNostr } from '@/providers/NostrProvider'
import { useUserPreferences } from '@/providers/UserPreferencesProvider'
import { ArrowDownUp, ChevronDown, LogIn, LogOut, Plus, Settings, UserRound, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import LoginDialog from '../LoginDialog'
import LogoutDialog from '../LogoutDialog'
import SignerTypeBadge from '../SignerTypeBadge'
import { SimpleUsername } from '../Username'
import SidebarItem from './SidebarItem'

export default function AccountButton({ collapse }: { collapse: boolean }) {
  const { pubkey } = useNostr()

  if (pubkey) {
    return <ProfileButton collapse={collapse} />
  } else {
    return <LoginButton collapse={collapse} />
  }
}

function ProfileButton({ collapse }: { collapse: boolean }) {
  const { t } = useTranslation()
  const { account, accounts, switchAccount, profile } = useNostr()
  const pubkey = account?.pubkey
  const { navigate, current, display } = usePrimaryPage()
  const { push } = useSecondaryPage()
  const { enableSingleColumnLayout } = useUserPreferences()
  const [loginDialogOpen, setLoginDialogOpen] = useState(false)
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false)
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false)
  if (!pubkey) return null

  const defaultAvatar = useMemo(() => generateImageByPubkey(pubkey), [pubkey])
  const avatar = profile?.metadata?.picture ?? defaultAvatar
  const username =
    profile?.metadata?.display_name || profile?.metadata?.name || formatPubkey(pubkey)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'clickable shadow-none p-2 flex items-center bg-transparent text-foreground hover:text-accent-foreground rounded-lg justify-start gap-4 text-lg font-semibold',
            collapse ? 'w-12 h-12' : 'w-full h-auto'
          )}
        >
          <div className="flex gap-2 items-center flex-1 w-0">
            <Avatar className="w-8 h-8">
              <AvatarImage src={avatar} />
              <AvatarFallback>
                <img src={defaultAvatar} />
              </AvatarFallback>
            </Avatar>
            {!collapse && <div className="truncate font-semibold text-lg">{username}</div>}
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-72">
        <DropdownMenuItem
          onClick={() => navigate('profile')}
          className={cn(display && current === 'profile' ? 'font-semibold' : '')}
        >
          <UserRound />
          {t('Profile')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            enableSingleColumnLayout ? navigate('settings') : push(toSettings())
          }
          className={cn(display && current === 'settings' ? 'font-semibold' : '')}
        >
          <Settings />
          {t('Settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => push(toWallet())}>
          <Wallet />
          {t('Wallet')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            setShowAccountSwitcher((prev) => !prev)
          }}
        >
          <ArrowDownUp />
          <div className="flex-1">{t('Switch account')}</div>
          <ChevronDown
            className={cn('transition-transform', showAccountSwitcher ? 'rotate-180' : '')}
          />
        </DropdownMenuItem>
        {showAccountSwitcher && (
          <div className="px-1 pb-2 space-y-1">
            {accounts.map((act) => {
              const isCurrent = act.pubkey === pubkey
              const avatarUrl = isCurrent
                ? avatar
                : act.pubkey
                ? generateImageByPubkey(act.pubkey)
                : undefined
              return (
                <DropdownMenuItem
                  key={`${act.pubkey}:${act.signerType}`}
                  className={cn('flex items-center gap-2', isCurrent && 'cursor-default focus:bg-background')}
                  onClick={(e) => {
                    e.preventDefault()
                    if (!isCurrent) {
                      switchAccount(act)
                    }
                  }}
                >
                  <div className="flex gap-2 items-center flex-1">
                    <Avatar className="w-8 h-8">
                      <AvatarImage src={avatarUrl} />
                      <AvatarFallback>
                        <img src={generateImageByPubkey(act.pubkey)} />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 w-0">
                      <SimpleUsername
                        userId={act.pubkey}
                        className="font-medium truncate"
                        skeletonClassName="h-3"
                      />
                      <SignerTypeBadge signerType={act.signerType} />
                    </div>
                  </div>
                  <div
                    className={cn(
                      'border border-muted-foreground rounded-full size-3.5',
                      isCurrent && 'size-4 border-4 border-primary'
                    )}
                  />
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuItem
              onClick={(e) => {
                e.preventDefault()
                setShowAccountSwitcher(false)
                setLoginDialogOpen(true)
              }}
              className="border border-dashed focus:border-muted-foreground focus:bg-background"
            >
              <div className="flex gap-2 items-center justify-center w-full py-2">
                <Plus />
                {t('Add an Account')}
              </div>
            </DropdownMenuItem>
          </div>
        )}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => setLogoutDialogOpen(true)}
        >
          <LogOut />
          <span className="shrink-0">{t('Logout')}</span>
          <SimpleUsername
            userId={pubkey}
            className="text-muted-foreground border border-muted-foreground px-1 rounded-md text-xs truncate"
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
      <LoginDialog open={loginDialogOpen} setOpen={setLoginDialogOpen} />
      <LogoutDialog open={logoutDialogOpen} setOpen={setLogoutDialogOpen} />
    </DropdownMenu>
  )
}

function LoginButton({ collapse }: { collapse: boolean }) {
  const { checkLogin } = useNostr()

  return (
    <SidebarItem onClick={() => checkLogin()} title="Login" collapse={collapse}>
      <LogIn />
    </SidebarItem>
  )
}
