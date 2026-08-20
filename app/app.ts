/*
In NativeScript, the app.ts file is the entry point to your application.
You can use this file to perform app-level initialization, but the primary
purpose of the file is to pass control to the app’s first module.
*/

import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { startWhatsAppNode, whatsAppNodeHealth } from './native/whatsapp-node'

registerShareIntentHandler()

// Milestone 1a: boot the embedded Node WhatsApp engine and confirm the loopback
// server answers. Best-effort; never blocks app startup.
Application.on(Application.launchEvent, () => {
  try {
    startWhatsAppNode()
    void whatsAppNodeHealth().then((health) => {
      if (health) console.log(`[whatsapp-node] engine up: node ${health.node} ${health.arch}`)
    })
  } catch (error) {
    console.error(`[whatsapp-node] boot hook failed: ${error}`)
  }
})

Application.run({ moduleName: 'app-root' })

// Don't place any code after the application has been started
