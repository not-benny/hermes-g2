/*
In NativeScript, the app.ts file is the entry point to your application.
You can use this file to perform app-level initialization, but the primary
purpose of the file is to pass control to the app’s first module.
*/

import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { seedPreviewDemo } from './native/preview-demo'
// Exact-alarm receivers can cold-start NativeScriptApplication without an
// Activity. Eager construction registers the durable Clock listener and
// coordinator before the receiver dispatches its persisted due edge.
import './g2/dashboard-controller'

registerShareIntentHandler()

// Preview-only users have no glasses/ring; seed anonymous demo health data so the
// Health tab + HUD are explorable. No-op outside preview mode; cleared on exit.
try {
  seedPreviewDemo()
} catch (error) {
  console.error(`[preview-demo] seed failed: ${error}`)
}

Application.run({ moduleName: 'app-root' })

// Don't place any code after the application has been started
