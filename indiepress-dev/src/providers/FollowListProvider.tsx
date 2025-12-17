import { createFollowListDraftEvent } from '@/lib/draft-event'
import { createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useNostr } from './NostrProvider'
import { loadFollowsList } from '@nostr/gadgets/lists'

type TFollowListContext = {
  followList: string[]
  followings: string[]
  follow: (pubkey: string) => Promise<void>
  followMultiple: (pubkeys: string[]) => Promise<void>
  unfollow: (pubkey: string) => Promise<void>
  unfollowMultiple: (pubkeys: string[]) => Promise<void>
}

const FollowListContext = createContext<TFollowListContext | undefined>(undefined)

export const useFollowList = () => {
  const context = useContext(FollowListContext)
  if (!context) {
    throw new Error('useFollowList must be used within a FollowListProvider')
  }
  return context
}

export function FollowListProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { pubkey: accountPubkey, followList, publish, updateFollowListEvent } = useNostr()

  const follow = async (pubkey: string) => {
    if (!accountPubkey) return

    const follows = await loadFollowsList(accountPubkey)
    if (!follows.event) {
      const result = confirm(t('FollowListNotFoundConfirmation'))
      if (!result) return
    }

    const existingTags = follows.event?.tags ?? []
    const alreadyFollowing = existingTags.some((tag) => tag[0] === 'p' && tag[1] === pubkey)
    if (alreadyFollowing) return

    const newFollowListDraftEvent = createFollowListDraftEvent(
      [...existingTags, ['p', pubkey]],
      follows.event?.content || ''
    )
    const newFollowListEvent = await publish(newFollowListDraftEvent)
    await updateFollowListEvent(newFollowListEvent)
  }

  const followMultiple = async (pubkeys: string[]) => {
    if (!accountPubkey || !pubkeys.length) return

    const follows = await loadFollowsList(accountPubkey)
    if (!follows.event) {
      const result = confirm(t('FollowListNotFoundConfirmation'))
      if (!result) return
    }

    const existingTags = follows.event?.tags ?? []
    const existingPubkeys = new Set(
      existingTags.filter((tag) => tag[0] === 'p').map((tag) => tag[1])
    )
    const newPubkeys = pubkeys.filter((pk) => !existingPubkeys.has(pk))
    if (!newPubkeys.length) return

    const newPTags = newPubkeys.map((pk) => ['p', pk] as [string, string])
    const newFollowListDraftEvent = createFollowListDraftEvent(
      [...existingTags, ...newPTags],
      follows.event?.content || ''
    )
    const newFollowListEvent = await publish(newFollowListDraftEvent)
    await updateFollowListEvent(newFollowListEvent)
  }

  const unfollow = async (pubkey: string) => {
    if (!accountPubkey) return

    const follows = await loadFollowsList(accountPubkey)
    if (!follows.event) return

    const newFollowListDraftEvent = createFollowListDraftEvent(
      follows.event.tags.filter(([tagName, tagValue]) => tagName !== 'p' || tagValue !== pubkey),
      follows.event.content
    )
    const newFollowListEvent = await publish(newFollowListDraftEvent)
    await updateFollowListEvent(newFollowListEvent)
  }

  const unfollowMultiple = async (pubkeys: string[]) => {
    if (!accountPubkey || !pubkeys.length) return

    const follows = await loadFollowsList(accountPubkey)
    if (!follows.event) return

    const removeSet = new Set(pubkeys)
    const newFollowListDraftEvent = createFollowListDraftEvent(
      follows.event.tags.filter(
        ([tagName, tagValue]) => tagName !== 'p' || !removeSet.has(tagValue)
      ),
      follows.event.content
    )
    const newFollowListEvent = await publish(newFollowListDraftEvent)
    await updateFollowListEvent(newFollowListEvent)
  }

  return (
    <FollowListContext.Provider
      value={{
        followList,
        followings: followList,
        follow,
        followMultiple,
        unfollow,
        unfollowMultiple
      }}
    >
      {children}
    </FollowListContext.Provider>
  )
}
