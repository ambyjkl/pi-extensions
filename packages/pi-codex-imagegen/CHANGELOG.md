# @narumitw/pi-codex-imagegen

## 0.1.1

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.1.0

### Minor Changes

- 393c25e: Add experimental image generation through the Codex image endpoint with an `/codex-imagegen` menu, user settings, and an opt-in model tool. No Codex agent or plugins are started.
- afa50bc: Require an exact `path` for image generation and remove the output-directory setting. Use Pi-native path resolution, overwrite existing files, follow symlinks, and request a destination in the manual menu without adding extensions or generating filenames.
