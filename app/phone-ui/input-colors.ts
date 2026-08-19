import { Color, isAndroid, TextField, View } from '@nativescript/core'

// Some Samsung ROMs render the native EditText text/hint with their own colors
// regardless of NativeScript CSS, which produces unreadable fields (white-on-white
// under the old light theme, dark-on-dark under the dark theme). Force the native
// colors to the dark-theme palette so inputs stay legible everywhere.
const INPUT_TEXT_COLOR = new Color('#EAF2EC')
const INPUT_PLACEHOLDER_COLOR = new Color('#9BB0A5')

export function applyNativeInputColors(textField: TextField): void {
  textField.color = INPUT_TEXT_COLOR
  textField.placeholderColor = INPUT_PLACEHOLDER_COLOR

  if (!isAndroid) {
    return
  }

  const nativeTextField = (textField as TextField & { nativeView?: android.widget.EditText }).nativeView
  if (!nativeTextField) {
    return
  }

  nativeTextField.setTextColor(android.graphics.Color.rgb(234, 242, 236))
  nativeTextField.setHintTextColor(android.graphics.Color.rgb(155, 176, 165))
}

// Walk the visual tree and force legible colors on every TextField it contains.
// Useful for pages whose inputs have no ids to look up individually.
export function applyInputColors(root: View): void {
  root.eachChildView((child) => {
    if (child instanceof TextField) {
      applyNativeInputColors(child)
    } else if (child instanceof View) {
      applyInputColors(child)
    }
    return true
  })
}
