import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"
import {
  translate,
  type AppLanguage,
  type TranslationKey,
} from "./i18n-messages"

export {
  translate,
  type AppLanguage,
  type TranslationKey,
} from "./i18n-messages"

interface I18nValue {
  language: AppLanguage
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nValue>({
  language: "zh-CN",
  t: (key, values) => translate("zh-CN", key, values),
})

export function I18nProvider({
  language,
  children,
}: {
  language: AppLanguage
  children: ReactNode
}) {
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  const value = useMemo<I18nValue>(
    () => ({ language, t: (key, values) => translate(language, key, values) }),
    [language],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
