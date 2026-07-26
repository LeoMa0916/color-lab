# Color Engine 4 validation data

The production application never uploads photographs. Public or generated
fixtures must be listed in `datasets.json` with their license and redistribution
status before they can enter the regression gate.

Private camera originals belong in `qa-private/`, which is excluded from Git.
The local index stores only a SHA-256 hash, camera make/model, scenario, role,
and numeric test result. It must not store the original path, file name,
thumbnail, or image bytes.

The generated seven-scenario matrix is released as CC0-1.0. It covers portrait,
sky, foliage, mixed light, night, high contrast, and neutral scenes. It is an
engineering regression fixture, not evidence of camera-brand calibration.

Fujifilm and Hasselblad remain `reference-driven-approximation` until each has
at least 30 qualified, cross-scene reference/target groups. Updating a count
without also changing the status consistently fails `verify:datasets`.

Run the complete gate with:

```sh
npm run verify:all
```
