# Local semantic model

`selfie_multiclass_256x256.tflite` is the MediaPipe Selfie Multiclass
Segmentation model. It is downloaded by the app only when semantic portrait
analysis is needed and runs locally in the browser.

- Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf
- Upstream artifact: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite
- License: Apache License 2.0

The MediaPipe WebAssembly runtime in `public/mediapipe/wasm` is distributed by
the `@mediapipe/tasks-vision` npm package under the Apache License 2.0.
