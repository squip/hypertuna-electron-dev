import 'yet-another-react-lightbox/styles.css'
import './index.css'

import { Toaster } from '@/components/ui/sonner'
import LinkPreviewHoverUI from '@/components/LinkPreviewHoverUI'
import { BookmarksProvider } from '@/providers/BookmarksProvider'
import { ContentPolicyProvider } from '@/providers/ContentPolicyProvider'
import { DeletedEventProvider } from '@/providers/DeletedEventProvider'
import { FavoriteRelaysProvider } from '@/providers/FavoriteRelaysProvider'
import { FeedProvider } from '@/providers/FeedProvider'
import { FollowListProvider } from '@/providers/FollowListProvider'
import { GroupedNotesProvider } from '@/providers/GroupedNotesProvider'
import { KindFilterProvider } from '@/providers/KindFilterProvider'
import { LinkPreviewHoverProvider } from '@/providers/LinkPreviewHoverProvider'
import { ListsProvider } from '@/providers/ListsProvider'
import { MediaUploadServiceProvider } from '@/providers/MediaUploadServiceProvider'
import { MuteListProvider } from '@/providers/MuteListProvider'
import { NostrProvider } from '@/providers/NostrProvider'
import { PinBuryProvider } from '@/providers/PinBuryProvider'
import { PinListProvider } from '@/providers/PinListProvider'
import { ReplyProvider } from '@/providers/ReplyProvider'
import { ScreenSizeProvider } from '@/providers/ScreenSizeProvider'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { TranslationServiceProvider } from '@/providers/TranslationServiceProvider'
import { UserPreferencesProvider } from '@/providers/UserPreferencesProvider'
import { UserTrustProvider } from '@/providers/UserTrustProvider'
import { ZapProvider } from '@/providers/ZapProvider'
import { MessengerProvider } from '@/providers/MessengerProvider'
import { NotepadProvider } from '@/providers/NotepadProvider'
import { PageManager } from './PageManager'
import { GroupsProvider } from './providers/GroupsProvider'
import { WorkerBridgeProvider } from './providers/WorkerBridgeProvider'

export default function App(): JSX.Element {
  return (
    <WorkerBridgeProvider>
      <ScreenSizeProvider>
        <UserPreferencesProvider>
          <LinkPreviewHoverProvider>
            <ThemeProvider>
              <ContentPolicyProvider>
                <DeletedEventProvider>
                  <NostrProvider>
                    <ZapProvider>
                      <TranslationServiceProvider>
                        <FavoriteRelaysProvider>
                          <FollowListProvider>
                            <PinBuryProvider>
                              <MuteListProvider>
                                <UserTrustProvider>
                                  <ListsProvider>
                                    <BookmarksProvider>
                                      <PinListProvider>
                                        <FeedProvider>
                                          <ReplyProvider>
                                            <MediaUploadServiceProvider>
                                              <KindFilterProvider>
                                                <GroupedNotesProvider>
                                                  <MessengerProvider>
                                                    <NotepadProvider>
                                                      <GroupsProvider>
                                                        <PageManager />
                                                      </GroupsProvider>
                                                    </NotepadProvider>
                                                  </MessengerProvider>
                                                  <Toaster />
                                                  <LinkPreviewHoverUI />
                                                </GroupedNotesProvider>
                                              </KindFilterProvider>
                                            </MediaUploadServiceProvider>
                                          </ReplyProvider>
                                        </FeedProvider>
                                      </PinListProvider>
                                    </BookmarksProvider>
                                  </ListsProvider>
                                </UserTrustProvider>
                              </MuteListProvider>
                            </PinBuryProvider>
                          </FollowListProvider>
                        </FavoriteRelaysProvider>
                      </TranslationServiceProvider>
                    </ZapProvider>
                  </NostrProvider>
                </DeletedEventProvider>
              </ContentPolicyProvider>
            </ThemeProvider>
          </LinkPreviewHoverProvider>
        </UserPreferencesProvider>
      </ScreenSizeProvider>
    </WorkerBridgeProvider>
  )
}
