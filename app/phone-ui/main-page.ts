import { Color, EventData, isAndroid, Observable, Page, ScrollView, TextField } from '@nativescript/core'
import { MainViewModel } from './main-view-model'
import { applyNativeInputColors } from './input-colors'
import { dashboardController } from '../g2/dashboard-controller'

const SETTINGS_BACKGROUND_COLOR = new Color('#1E2A22')

export function navigatingTo(args: EventData) {
  const page = <Page>args.object
  page.bindingContext = new MainViewModel()
}

type MainPageState = {
  model: MainViewModel
  isPinnedToBottom: boolean
  disposed: boolean
  layoutTimer: ReturnType<typeof setTimeout> | null
  scrollViews: ScrollView[]
  scrollHandler: (args: EventData) => void
  propertyChangeHandler: (args: EventData & { propertyName?: string }) => void
  layoutHandler: () => void
}

function getPageState(page: Page): MainPageState | undefined {
  return (page as Page & { __mainPageState?: MainPageState }).__mainPageState
}

function setPageState(page: Page, state?: MainPageState): void {
  ;(page as Page & { __mainPageState?: MainPageState }).__mainPageState = state
}

function cleanupPage(page: Page): void {
  const state = getPageState(page)
  if (!state) {
    setPageState(page, undefined)
    return
  }
  for (const scrollView of state.scrollViews) {
    scrollView.off(ScrollView.scrollEvent, state.scrollHandler)
  }
  state.disposed = true
  if (state.layoutTimer !== null) {
    clearTimeout(state.layoutTimer)
    state.layoutTimer = null
  }
  state.model.off(Observable.propertyChangeEvent, state.propertyChangeHandler)
  state.model.dispose()
  page.off(Page.layoutChangedEvent, state.layoutHandler)
  setPageState(page, undefined)
}

function isAtBottom(scrollView: ScrollView): boolean {
  return scrollView.scrollableHeight <= 0 || scrollView.verticalOffset >= scrollView.scrollableHeight - 8
}

function scrollToBottom(scrollView: ScrollView): void {
  setTimeout(() => {
    scrollView.scrollToVerticalOffset(scrollView.scrollableHeight, false)
  }, 0)
}

function scrollLogsToBottom(scrollViews: ScrollView[]): void {
  for (const scrollView of scrollViews) {
    scrollToBottom(scrollView)
  }
}

function applySettingsTextFieldContrast(textField: TextField): void {
  applyNativeInputColors(textField)
  textField.backgroundColor = SETTINGS_BACKGROUND_COLOR

  if (!isAndroid) {
    return
  }

  const nativeTextField = (textField as TextField & { nativeView?: android.widget.EditText }).nativeView
  if (!nativeTextField) {
    return
  }

  // Editing an existing value usually means replacing it: select all on focus
  // so typing starts fresh but the current value stays visible.
  nativeTextField.setSelectAllOnFocus(true)
}

function focusSystemNameField(page: Page): void {
  setTimeout(() => {
    const textField = page.getViewById<TextField>('settingsTextField')
    if (textField) {
      applySettingsTextFieldContrast(textField)
    }
    textField?.focus()
  }, 0)
}

export function loaded(args: EventData) {
  const page = args.object as Page
  cleanupPage(page)
  dashboardController.refreshEvenAppStatus()

  const model = page.bindingContext as MainViewModel | null
  // Restore saved app windows only after auto-connect has either prepared the
  // compositor or determined there is no configured device. Launching a worker
  // while the G2 surface is still unconfigured loses its first render.
  if (model) {
    void model.autoConnect().then(() => dashboardController.restoreOpenApps())
  } else {
    void dashboardController.restoreOpenApps()
  }
  const scrollViews = [
    page.getViewById<ScrollView>('logScrollView'),
    page.getViewById<ScrollView>('logScrollViewLandscape'),
  ].filter((scrollView): scrollView is ScrollView => !!scrollView)
  const settingsTextField = page.getViewById<TextField>('settingsTextField')
  const initialSize = page.getActualSize()
  model?.refreshLayoutMetrics(initialSize.width, initialSize.height)
  if (settingsTextField) {
    applySettingsTextFieldContrast(settingsTextField)
  }
  if (!model || scrollViews.length === 0) {
    return
  }

  const state: MainPageState = {
    model,
    isPinnedToBottom: true,
    disposed: false,
    layoutTimer: null,
    scrollViews,
    scrollHandler: (scrollArgs) => {
      state.isPinnedToBottom = isAtBottom(scrollArgs.object as ScrollView)
    },
    layoutHandler: () => {
      if (state.layoutTimer !== null) {
        clearTimeout(state.layoutTimer)
      }
      state.layoutTimer = setTimeout(() => {
        state.layoutTimer = null
        if (state.disposed) return
        const size = page.getActualSize()
        model.refreshLayoutMetrics(size.width, size.height)
        if (state.isPinnedToBottom) {
          scrollLogsToBottom(scrollViews)
        }
      }, 0)
    },
    propertyChangeHandler: (propertyArgs) => {
      if (propertyArgs.propertyName === 'showLog') {
        if (model.showLog) {
          state.isPinnedToBottom = true
          scrollLogsToBottom(scrollViews)
        }
        return
      }
      if (propertyArgs.propertyName === 'activeTextSettingId') {
        if (model.isTextSettingEditorActive) {
          focusSystemNameField(page)
        }
        return
      }
      if (propertyArgs.propertyName !== 'log') {
        return
      }
      if (state.isPinnedToBottom) {
        scrollLogsToBottom(scrollViews)
      }
    },
  }

  for (const scrollView of scrollViews) {
    scrollView.on(ScrollView.scrollEvent, state.scrollHandler)
  }
  model.on(Observable.propertyChangeEvent, state.propertyChangeHandler)
  page.on(Page.layoutChangedEvent, state.layoutHandler)
  setPageState(page, state)
  scrollLogsToBottom(scrollViews)
  if (model.isTextSettingEditorActive) {
    focusSystemNameField(page)
  }
}

export function unloaded(args: EventData) {
  cleanupPage(args.object as Page)
}
