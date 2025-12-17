import { createContext, useContext, useEffect, useState } from 'react'

type TScreenSizeContext = {
  isSmallScreen: boolean
  isLargeScreen: boolean
}

const ScreenSizeContext = createContext<TScreenSizeContext | undefined>(undefined)

export const useScreenSize = () => {
  const context = useContext(ScreenSizeContext)
  if (!context) {
    throw new Error('useScreenSize must be used within a ScreenSizeProvider')
  }
  return context
}

export function ScreenSizeProvider({ children }: { children: React.ReactNode }) {
  const [dims, setDims] = useState(() => ({
    isSmallScreen: typeof window !== 'undefined' ? window.innerWidth <= 768 : false,
    isLargeScreen: typeof window !== 'undefined' ? window.innerWidth >= 1280 : false
  }))

  useEffect(() => {
    const mqSmall = window.matchMedia('(max-width: 768px)')
    const mqLarge = window.matchMedia('(min-width: 1280px)')
    const update = () =>
      setDims({
        isSmallScreen: mqSmall.matches,
        isLargeScreen: mqLarge.matches
      })
    update()
    mqSmall.addEventListener('change', update)
    mqLarge.addEventListener('change', update)
    return () => {
      mqSmall.removeEventListener('change', update)
      mqLarge.removeEventListener('change', update)
    }
  }, [])

  return (
    <ScreenSizeContext.Provider
      value={{
        isSmallScreen: dims.isSmallScreen,
        isLargeScreen: dims.isLargeScreen
      }}
    >
      {children}
    </ScreenSizeContext.Provider>
  )
}
