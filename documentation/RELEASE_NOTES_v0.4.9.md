# Papilio Loader v0.4.9

## Highlights

- Board Recovery now combines the latest Papilio ESP Bootloader app with the
  latest FPGA-Companion migration image instead of reporting a newer loader
  version than the image actually contains.
- The recovery page links directly to the exact bundled recovery image and
  displays the versions of both firmware components.
- Updated web asset cache version to refresh the recovery page and its firmware
  manifest.

## Validation

- Web assets build successfully.
- The generated recovery image is checked against the released partition table,
  factory app size, and `ota_0` image before it is published.
