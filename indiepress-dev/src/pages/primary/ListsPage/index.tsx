import { useSecondaryPage } from '@/PageManager'
import UserAvatar from '@/components/UserAvatar'
import Username from '@/components/Username'
import NoteList from '@/components/NoteList'
import ProfileList from '@/components/ProfileList'
import TabsBar, { TTabDefinition } from '@/components/Tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { toCreateList, toEditList } from '@/lib/link'
import localStorageService from '@/services/local-storage.service'
import listStatsService from '@/services/list-stats.service'
import { useFollowList } from '@/providers/FollowListProvider'
import { useLists, TStarterPack } from '@/providers/ListsProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { TPageRef } from '@/types'
import client from '@/services/client.service'
import { ExtendedKind, BIG_RELAY_URLS } from '@/constants'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Check, Edit, ListFilter, Loader2, PencilLine, Plus, Search, Star, Trash2, UserPlus } from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import ListEditorForm from '@/components/ListEditorForm'
import { Event } from '@nostr/tools/wasm'
import PullToRefresh from 'react-simple-pull-to-refresh'

type TSortBy = 'recent' | 'zaps'

const ListsPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current)

  const { pubkey, checkLogin } = useNostr()
  const { push } = useSecondaryPage()
  const { lists, isLoading: isLoadingMyLists, deleteList, fetchLists } = useLists()
  const { followings = [], followMultiple, unfollowMultiple } = useFollowList()
  const { isSmallScreen } = useScreenSize()

  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<TStarterPack[]>([])
  const [allPublicLists, setAllPublicLists] = useState<TStarterPack[]>([])
  const [isLoadingPublicLists, setIsLoadingPublicLists] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [listToDelete, setListToDelete] = useState<string | null>(null)
  const [selectedList, setSelectedList] = useState<TStarterPack | null>(null)
  const [isLoadingSelectedList, setIsLoadingSelectedList] = useState(false)
  const [favoriteLists, setFavoriteLists] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'notes' | 'members'>('notes')
  const [activeSection, setActiveSection] = useState<'discover' | 'favorites' | 'my'>('discover')
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<TSortBy>('recent')
  const [followedLists, setFollowedLists] = useState<Set<string>>(new Set())
  const [showSearchBar, setShowSearchBar] = useState(!isSmallScreen)
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [listStatsVersion, setListStatsVersion] = useState(0) // used to trigger re-sorts when stats change

  const parseStarterPackEvent = (event: Event): TStarterPack => {
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] || ''
    const title = event.tags.find((tag) => tag[0] === 'title')?.[1] || 'Untitled List'
    const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
    const image = event.tags.find((tag) => tag[0] === 'image')?.[1]
    const pubkeys = event.tags?.filter((tag) => tag[0] === 'p').map((tag) => tag[1]) || []

    return {
      id: dTag,
      title,
      description,
      image,
      pubkeys,
      event
    }
  }

  useEffect(() => {
    setShowSearchBar(!isSmallScreen)
  }, [isSmallScreen])

  useEffect(() => {
    if (pubkey) {
      fetchLists()
    }
  }, [pubkey])

  useEffect(() => {
    setFavoriteLists(localStorageService.getFavoriteLists(pubkey))
  }, [pubkey])

  useEffect(() => {
    const loadStats = async () => {
      if (!lists || !lists.length) return
      await Promise.all(
        lists.map((list) => listStatsService.fetchListStats(list.event.pubkey, list.id, pubkey))
      )
      setListStatsVersion((v) => v + 1)
    }
    loadStats()
  }, [lists, pubkey])

  const fetchPublicLists = useCallback(async () => {
    setIsLoadingPublicLists(true)
    try {
      const events = await client.fetchEvents(BIG_RELAY_URLS.slice(0, 5), {
        kinds: [ExtendedKind.STARTER_PACK],
        limit: 50
      })

      const parsedLists: TStarterPack[] = events.map((event) => parseStarterPackEvent(event))
      parsedLists.sort((a, b) => b.event.created_at - a.event.created_at)

      const uniqueLists = parsedLists.filter(
        (list, index, self) =>
          index === self.findIndex((l) => l.event.pubkey === list.event.pubkey && l.id === list.id)
      )

      setAllPublicLists(uniqueLists)
    } catch (_error) {
      console.error('Failed to fetch public lists:', _error)
    } finally {
      setIsLoadingPublicLists(false)
    }
  }, [pubkey])

  useEffect(() => {
    const loadStats = async () => {
      if (!allPublicLists || !allPublicLists.length) return
      await Promise.all(
        allPublicLists.map((list) =>
          listStatsService.fetchListStats(list.event.pubkey, list.id, pubkey)
        )
      )
      setListStatsVersion((v) => v + 1)
    }
    loadStats()
  }, [allPublicLists, pubkey])

  useEffect(() => {
    fetchPublicLists()
  }, [fetchPublicLists])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }

    setIsSearching(true)

    const searchInLists = () => {
      const query = searchQuery.toLowerCase()
      const filtered = allPublicLists.filter((list) => {
        return (
          list.title.toLowerCase().includes(query) ||
          list.description?.toLowerCase().includes(query)
        )
      })
      setSearchResults(filtered)
      setIsSearching(false)
    }

    const debounce = setTimeout(searchInLists, 300)
    return () => clearTimeout(debounce)
  }, [searchQuery, allPublicLists])

  const sortLists = (listItems: TStarterPack[]) => {
    if (sortBy === 'zaps') {
      return [...listItems].sort((a, b) => {
        const aZaps = listStatsService.getTotalZapAmount?.(a.event.pubkey, a.id) || 0
        const bZaps = listStatsService.getTotalZapAmount?.(b.event.pubkey, b.id) || 0
        return bZaps - aZaps
      })
    }
    return [...listItems].sort((a, b) => b.event.created_at - a.event.created_at)
  }

  const startCreateList = () => {
    const openEditor = () => {
      if (isSmallScreen) {
        setCreateSheetOpen(true)
      } else {
        push(toCreateList())
      }
    }

    if (!pubkey) {
      checkLogin(() => openEditor())
      return
    }

    openEditor()
  }

  const handleListClick = async (listId: string) => {
    let ownerPubkey: string | undefined
    let dTag: string

    if (listId.includes(':')) {
      const [listPubkey, tag] = listId.split(':')
      ownerPubkey = listPubkey
      dTag = tag
    } else {
      ownerPubkey = pubkey || undefined
      dTag = listId
    }

    const ownList = Array.isArray(lists) ? lists.find((l) => l.id === dTag) : null

    if (ownList) {
      setSelectedList(ownList)
      listStatsService.fetchListStats(ownList.event.pubkey, ownList.id, pubkey)
      return
    }

    if (!ownerPubkey || !dTag) return

    setIsLoadingSelectedList(true)
    try {
      const events = await client.fetchEvents(BIG_RELAY_URLS.slice(0, 5), {
        kinds: [ExtendedKind.STARTER_PACK],
        authors: [ownerPubkey],
        '#d': [dTag],
        limit: 1
      })
      if (events.length > 0) {
        const list = parseStarterPackEvent(events[0])
        setSelectedList(list)
        listStatsService.fetchListStats(list.event.pubkey, list.id, pubkey)
      }
    } catch (_error) {
      console.error('Failed to fetch list:', _error)
    } finally {
      setIsLoadingSelectedList(false)
    }
  }

  const handleDeleteList = async () => {
    if (!listToDelete) return
    try {
      await deleteList(listToDelete)
      toast.success(t('Delete') + ' ' + t('successfully'))
    } catch (_error) {
      toast.error(t('Delete') + ' ' + t('failed'))
    } finally {
      setDeleteDialogOpen(false)
      setListToDelete(null)
    }
  }

  const handleToggleFavorite = (listKey: string) => {
    if (favoriteLists.includes(listKey)) {
      localStorageService.removeFavoriteList(listKey, pubkey)
    } else {
      localStorageService.addFavoriteList(listKey, pubkey)
    }
    setFavoriteLists(localStorageService.getFavoriteLists(pubkey))
  }

  const handleFollowAllMembers = async (pubkeys: string[], listKey?: string) => {
    const alreadyFollowingAll =
      pubkeys.length === 0 ||
      pubkeys.every((pk) => pk && (pk === pubkey || followings.includes(pk))) ||
      (listKey ? followedLists.has(listKey) : false)

    const followAction = async () => {
      const unique = pubkeys.filter((pk) => pk && pk !== pubkey && !followings.includes(pk))
      if (!unique.length) {
        toast.info(t('You are already following everyone in this list'))
        return
      }

      try {
        await followMultiple(unique)
        if (listKey) {
          setFollowedLists((prev) => new Set(prev).add(listKey))
        }
        toast.success(t('Followed all members'))
      } catch (_error) {
        toast.error(t('Follow failed'))
      }
    }

    const unfollowAction = async () => {
      const targets = pubkeys.filter((pk) => pk && pk !== pubkey && followings.includes(pk))
      if (!targets.length) return

      try {
        await unfollowMultiple(targets)
        if (listKey) {
          setFollowedLists((prev) => {
            const next = new Set(prev)
            next.delete(listKey)
            return next
          })
        }
        toast.success(t('Unfollowed all members'))
      } catch (_error) {
        toast.error(t('Unfollow failed'))
      }
    }

    if (!pubkey) {
      await checkLogin(() => (alreadyFollowingAll ? unfollowAction() : followAction()))
      return
    }

    if (alreadyFollowingAll) {
      await unfollowAction()
    } else {
      await followAction()
    }
  }

  const refreshSelectedList = async () => {
    if (!selectedList) return
    const listKey = `${selectedList.event.pubkey}:${selectedList.id}`
    await handleListClick(listKey)
  }

  const handleRefresh = async () => {
    if (selectedList) {
      await refreshSelectedList()
      await fetchLists()
      await fetchPublicLists()
      return
    }
    await Promise.all([fetchLists(), fetchPublicLists()])
  }

  const renderListCard = (list: TStarterPack, isOwnList: boolean) => {
    const listKey = `${list.event.pubkey}:${list.id}`
    const isFavorite = favoriteLists.includes(listKey)
    const isExpanded = expandedDescriptions.has(listKey)
    const memberCount = Array.isArray(list.pubkeys) ? list.pubkeys.length : 0
    const alreadyFollowedAll =
      memberCount === 0 ||
      list.pubkeys.every((pk) => pk === pubkey || followings.includes(pk)) ||
      followedLists.has(listKey)

    const descriptionNeedsTruncation = (list.description?.length || 0) > 140

    return (
      <Card
        key={listKey}
        className={`cursor-pointer transition-colors ${isSmallScreen ? 'rounded-none border-x-0 shadow-none' : 'hover:bg-accent/50'} overflow-hidden`}
        onClick={() => handleListClick(listKey)}
      >
        <CardContent className={isSmallScreen ? 'py-4 px-0' : 'p-4'}>
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3">
              {list.image && (
                <img
                  src={list.image}
                  alt={list.title}
                  className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-lg line-clamp-2 mb-1">{list.title}</h3>
                <div className="flex items-center gap-2 text-sm text-muted-foreground flex-nowrap min-w-0">
                  <span className="whitespace-nowrap">
                    {memberCount} {memberCount === 1 ? t('member') : t('members')}
                  </span>
                  {!isOwnList && (
                    <>
                      <span className="text-muted-foreground">•</span>
                      <div className="inline-flex items-center gap-1 min-w-0 whitespace-nowrap">
                        <span>{t('By')}</span>
                        <UserAvatar userId={list.event.pubkey} size="xSmall" className="inline-block" />
                        <Username
                          userId={list.event.pubkey}
                          className="font-medium inline truncate max-w-[120px] min-w-0"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {!isOwnList && (
                  <Button
                    variant={alreadyFollowedAll ? 'default' : 'outline'}
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleFollowAllMembers(list.pubkeys || [], listKey)
                    }}
                    title={
                      alreadyFollowedAll ? t('Unfollow all members') : t('Follow all members')
                    }
                    className="text-xs px-2 h-8 whitespace-nowrap"
                  >
                    {alreadyFollowedAll ? (
                      <>
                        <Check className="w-3 h-3 mr-1" />
                        {t('Unfollow')}
                      </>
                    ) : (
                      t('Follow all')
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleToggleFavorite(listKey)
                  }}
                  title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
                >
                  <Star className={`w-4 h-4 ${isFavorite ? 'fill-current text-yellow-500' : 'text-muted-foreground'}`} />
                </Button>
                {isOwnList && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        push(toEditList(list.id))
                      }}
                      title={t('Edit')}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        setListToDelete(list.id)
                        setDeleteDialogOpen(true)
                      }}
                      title={t('Delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>

            {list.description && (
              <div className="text-sm text-muted-foreground">
                {descriptionNeedsTruncation && !isExpanded ? (
                  <>
                    {list.description.substring(0, 140)}...{' '}
                    <button
                      className="text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedDescriptions((prev) => new Set(prev).add(listKey))
                      }}
                    >
                      {t('Show more...')}
                    </button>
                  </>
                ) : (
                  list.description
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  const renderSelectedList = () => {
    if (isLoadingSelectedList) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('Loading...')}
        </div>
      )
    }

    if (!selectedList) return null

    const listKey = `${selectedList.event.pubkey}:${selectedList.id}`
    const isFavorite = favoriteLists.includes(listKey)
    const pubkeys = Array.isArray(selectedList.pubkeys) ? selectedList.pubkeys : []
    const memberCount = pubkeys.length

    return (
      <div className="flex flex-col h-full">
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedList(null)}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('Back to Lists')}
            </Button>

            {memberCount > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleFavorite(listKey)}
                  title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
                >
                  <Star className={`w-4 h-4 ${isFavorite ? 'fill-current text-yellow-500' : 'text-muted-foreground'}`} />
                </Button>
                <Button
                  variant={followedLists.has(listKey) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleFollowAllMembers(pubkeys, listKey)}
                  title={
                    followedLists.has(listKey)
                      ? t('Unfollow all members')
                      : t('Follow all members')
                  }
                >
                  <UserPlus className="w-4 h-4 mr-2" />
                  {followedLists.has(listKey) ? t('Unfollow') : t('Follow all members')}
                </Button>
                {selectedList.event.pubkey === pubkey && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => push(toEditList(selectedList.id))}
                  >
                    <Edit className="w-4 h-4 mr-2" />
                    {t('Edit')}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-start gap-4">
            {selectedList.image && (
              <img
                src={selectedList.image}
                alt={selectedList.title}
                className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-2xl font-bold mb-1">{selectedList.title}</h2>
              </div>
              {selectedList.event.pubkey !== pubkey && (
                <div className="text-sm text-muted-foreground mb-2 flex items-center gap-1">
                  <span>{t('By')}</span>
                  <UserAvatar userId={selectedList.event.pubkey} size="small" />
                  <Username userId={selectedList.event.pubkey} className="font-medium" />
                </div>
              )}
              <div className="text-sm text-muted-foreground mb-3">
                {memberCount} {memberCount === 1 ? t('member') : t('members')}
              </div>
              {selectedList.description && (
                <p className="text-sm text-muted-foreground">
                  {expandedDescriptions.has(listKey) ? (
                    selectedList.description
                  ) : selectedList.description.length > 140 ? (
                    <>
                      {selectedList.description.substring(0, 140)}...{' '}
                      <button
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedDescriptions((prev) => new Set(prev).add(listKey))
                        }}
                      >
                        {t('Show more...')}
                      </button>
                    </>
                  ) : (
                    selectedList.description
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {pubkeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <div className="text-muted-foreground">{t('No members in this list')}</div>
              {selectedList.event.pubkey === pubkey && (
                <Button onClick={() => push(toEditList(selectedList.id))} variant="outline">
                  {t('Add Members')}
                </Button>
              )}
            </div>
          ) : (
            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'notes' | 'members')} className="w-full">
              <div className="border-b">
                <TabsList className="w-full justify-start h-auto p-0 bg-transparent px-4">
                  <TabsTrigger
                    value="notes"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Notes')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="members"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Members')} ({memberCount})
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="notes" className="mt-0">
                <NoteList
                  subRequests={[
                    {
                      source: 'relays',
                      urls: BIG_RELAY_URLS,
                      filter: {
                        authors: pubkeys,
                        kinds: [1, 6]
                      }
                    }
                  ]}
                  showKinds={[1, 6]}
                />
              </TabsContent>
              <TabsContent value="members" className="mt-0">
                <ProfileList pubkeys={pubkeys} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    )
  }

  const favoriteListObjects = useMemo(() => {
    const listMap = new Map<string, TStarterPack>()
    ;(lists || []).forEach((l) => listMap.set(`${l.event.pubkey}:${l.id}`, l))
    ;(allPublicLists || []).forEach((l) => {
      const key = `${l.event.pubkey}:${l.id}`
      if (!listMap.has(key)) listMap.set(key, l)
    })
    if (selectedList) {
      const key = `${selectedList.event.pubkey}:${selectedList.id}`
      listMap.set(key, selectedList)
    }

    const favListObjects: TStarterPack[] = []
    favoriteLists.forEach((key) => {
      const match = listMap.get(key)
      if (match) {
        favListObjects.push(match)
      }
    })
    return favListObjects
  }, [favoriteLists, lists, allPublicLists, selectedList])

  const myListObjects = useMemo(() => {
    if (!lists) return []
    return lists.filter((list) => !favoriteLists.includes(`${list.event.pubkey}:${list.id}`))
  }, [lists, favoriteLists])

  const discoverListObjects = useMemo(() => {
    return allPublicLists || []
  }, [allPublicLists])

  const renderListGroup = (items: TStarterPack[]) => {
    if (!items.length) {
      return <div className="text-sm text-muted-foreground">{t('No lists found')}</div>
    }
    return (
      <div className={isSmallScreen ? 'divide-y border-y' : 'grid gap-3'}>
        {sortLists(items).map((list) =>
          renderListCard(list, list?.event?.pubkey === pubkey)
        )}
      </div>
    )
  }

  const sectionContent = useMemo(() => {
    if (activeSection === 'my' && isLoadingMyLists) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('Loading...')}
        </div>
      )
    }

    if (isLoadingPublicLists && activeSection === 'discover') {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          <div className="text-center text-muted-foreground">{t('Loading...')}</div>
        </div>
      )
    }

    switch (activeSection) {
      case 'favorites':
        return renderListGroup(favoriteListObjects)
      case 'my':
        return renderListGroup(myListObjects)
      default:
        return renderListGroup(discoverListObjects)
    }
  }, [
    activeSection,
    discoverListObjects,
    favoriteListObjects,
    isLoadingPublicLists,
    myListObjects,
    isLoadingMyLists,
    listStatsVersion,
    sortBy,
    followings,
    followedLists,
    isSmallScreen
  ])

  const filterControl = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <ListFilter className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setSortBy('recent')}>
          {t('Most recent')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setSortBy('zaps')}>
          {t('Most zapped')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const tabs = useMemo<TTabDefinition[]>(
    () => [
      { value: 'discover', label: 'Discover' },
      { value: 'favorites', label: 'Favorites' },
      { value: 'my', label: 'My Lists' }
    ],
    []
  )

  const renderTabs = !selectedList && !(isSmallScreen && showSearchBar) && !searchQuery && (
    <div className={isSmallScreen ? '' : 'px-4'}>
      <TabsBar
        tabs={tabs}
        value={activeSection}
        onTabChange={(tab) => setActiveSection(tab as 'discover' | 'favorites' | 'my')}
        options={isSmallScreen ? filterControl : null}
        topOffset="0"
        reserveOptionsSpace={!isSmallScreen}
      />
    </div>
  )

  const renderSearchBar = !selectedList && (!isSmallScreen || showSearchBar) && (
    <div className={`flex items-center gap-2 ${isSmallScreen && showSearchBar ? 'mt-4' : ''}`}>
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t('Search lists...') as string}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      {!isSmallScreen && !searchQuery && filterControl}
      {!isSmallScreen && (
        <Button onClick={startCreateList} size="default">
          <Plus className="w-4 h-4 mr-1" />
          {t('Create')}
        </Button>
      )}
    </div>
  )

  let content: React.ReactNode = null

  if (selectedList) {
    content = renderSelectedList()
  } else {
    content = (
      <div className="space-y-4">
        {!searchQuery && renderTabs}
        <div className={isSmallScreen ? 'px-4 space-y-4' : 'p-4 space-y-6'}>
          {renderSearchBar}

          {searchQuery ? (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">{t('Search Results')}</h2>
              {isSearching && (
                <div className="text-center text-muted-foreground py-8">{t('Searching...')}</div>
              )}
              {!isSearching && (!searchResults || searchResults.length === 0) && (
                <div className="text-center text-muted-foreground py-8">
                  {t('No starter packs found')}
                </div>
              )}
              {searchResults && searchResults.length > 0 && (
                <div className={isSmallScreen ? 'divide-y border-y' : 'grid gap-3'}>
                  {sortLists(searchResults).map((list) =>
                    renderListCard(list, list?.event?.pubkey === pubkey)
                  )}
                </div>
              )}
            </div>
          ) : (
            sectionContent
          )}
        </div>
      </div>
    )
  }

  return (
    <PrimaryPageLayout
      pageName="lists"
      ref={layoutRef}
      titlebar={
        <ListsPageTitlebar
          isSmallScreen={isSmallScreen}
          selectedListTitle={selectedList?.title}
          onToggleSearch={() => setShowSearchBar((prev) => !prev)}
          onCreateClick={startCreateList}
        />
      }
      displayScrollToTopButton
    >
      <PullToRefresh onRefresh={handleRefresh}>
        <div>{content}</div>
      </PullToRefresh>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('Are you sure you want to delete this list?')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteDialogOpen(false)}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteList}>{t('Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={createSheetOpen} onOpenChange={setCreateSheetOpen}>
        <SheetContent side="bottom" className="h-[90vh] p-0">
          <ScrollArea className="h-full">
            <div className="p-4">
              <ListEditorForm
                onSaved={() => setCreateSheetOpen(false)}
                onCancel={() => setCreateSheetOpen(false)}
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </PrimaryPageLayout>
  )
})

ListsPage.displayName = 'ListsPage'

export default ListsPage

function ListsPageTitlebar({
  isSmallScreen,
  selectedListTitle,
  onToggleSearch,
  onCreateClick
}: {
  isSmallScreen: boolean
  selectedListTitle?: string
  onToggleSearch: () => void
  onCreateClick: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-1 items-center h-full justify-between px-3">
      <div className="font-semibold text-lg flex-1 truncate">
        {selectedListTitle || t('Lists')}
      </div>
      {isSmallScreen ? (
        <div className="shrink-0 flex gap-1 items-center">
          <Button variant="ghost" size="titlebar-icon" onClick={onToggleSearch}>
            <Search className="w-5 h-5" />
          </Button>
          <Button variant="ghost" size="titlebar-icon" onClick={onCreateClick}>
            <PencilLine className="w-5 h-5" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
