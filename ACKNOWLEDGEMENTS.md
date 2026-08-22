# Acknowledgements

Hermes G2 is based on [Faceclaw](https://github.com/jimrandomh/faceclaw) by
James Babcock and contributors. Their architecture, protocol work, firmware
integration, and GPL-licensed implementation made this fork possible.

Custom glasses-firmware flashing and the 2.2.8.4 port research build on
[g2flash](https://github.com/jimrandomh/g2flash), also by James Babcock. The
vendored source retains its upstream GPL licence and attribution.

Additional G2 protocol and firmware research draws on:

- [g2-kit-unofficial](https://github.com/Commute773/g2-kit-unofficial)
- [evenRealities-openCFW](https://github.com/kalanihelekunihi/evenRealities-openCFW)
- the wider Even Realities community's protocol and firmware documentation

Voice wake-word detection uses
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and its KWS Zipformer
GigaSpeech model. G2 microphone LC3 decoding uses
[Google liblc3](https://github.com/google/liblc3).

The Terminus font is by Dimitar Zhekov and the TerminusV proportional derivative
is by ohnonot. Both are distributed under the SIL Open Font License; see the
licence files under `app/fonts/terminus/` and `app/fonts/terminusv/`.

Hermes G2 remains GPL-3.0 software and retains applicable upstream copyright,
licence, and attribution notices.