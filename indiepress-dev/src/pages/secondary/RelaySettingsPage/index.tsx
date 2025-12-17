import MailboxSetting from '@/components/MailboxSetting'
import FavoriteRelaysSetting from '@/components/FavoriteRelaysSetting'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { forwardRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isElectron } from '@/lib/platform'
import RelayManagerPanel from '@/components/settings/RelayManagerPanel'
import GatewaySettingsPanel from '@/components/settings/GatewaySettingsPanel'
import PublicGatewayPanel from '@/components/settings/PublicGatewayPanel'

const RelaySettingsPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { t } = useTranslation()
  const [tabValue, setTabValue] = useState('favorite-relays')
  const hasDesktop = isElectron()

  useEffect(() => {
    switch (window.location.hash) {
      case '#mailbox':
        setTabValue('mailbox')
        break
      case '#hypertuna-desktop':
        if (hasDesktop) setTabValue('hypertuna-desktop')
        break
      case '#favorite-relays':
        setTabValue('favorite-relays')
        break
    }
  }, [hasDesktop])

  return (
    <SecondaryPageLayout ref={ref} index={index} title={t('Relay settings')}>
      <Tabs value={tabValue} onValueChange={setTabValue} className="px-4 py-3 space-y-4">
        <TabsList>
          <TabsTrigger value="favorite-relays">{t('Favorite Relays')}</TabsTrigger>
          <TabsTrigger value="mailbox">{t('Read & Write Relays')}</TabsTrigger>
          {hasDesktop && <TabsTrigger value="hypertuna-desktop">Hypertuna (Desktop)</TabsTrigger>}
        </TabsList>
        <TabsContent value="favorite-relays">
          <FavoriteRelaysSetting />
        </TabsContent>
        <TabsContent value="mailbox">
          <MailboxSetting />
        </TabsContent>
        {hasDesktop && (
          <TabsContent value="hypertuna-desktop" className="space-y-4">
            <RelayManagerPanel />
            <GatewaySettingsPanel />
            <PublicGatewayPanel />
          </TabsContent>
        )}
      </Tabs>
    </SecondaryPageLayout>
  )
})
RelaySettingsPage.displayName = 'RelaySettingsPage'
export default RelaySettingsPage
