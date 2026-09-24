# RivuLog Printer

Static Web Bluetooth bridge used by RivuLog to print its generated PNG labels
directly to an LX-D02 / LX-D2 family thermal printer.

## What it does

1. RivuLog generates the normal label and QR code.
2. RivuLog opens this bridge and sends the PNG with `postMessage`.
3. The bridge renders the PNG to the printer's 384-pixel raster.
4. A user click opens the browser Bluetooth chooser.
5. The label is printed over BLE.

The printer protocol and raster engine are built from the open-source
`cicloid/printable` project during GitHub Actions deployment.

## GitHub Pages setup

Create the repository as `rivulog-printer`, put these files on the `main`
branch, then open **Settings → Pages → Build and deployment** and choose
**GitHub Actions**.

The workflow builds the upstream WASM package and deploys the finished site.

Expected URL:

`https://pedromanuelsousano.github.io/rivulog-printer/`

## Browser

Use Chrome or Edge. Web Bluetooth requires HTTPS (GitHub Pages provides this).

## Printer

RivuLog currently targets the LX-D02 / LX-D2 family. Pedro's printer advertises
as `LX-D02-D6`, which matches the bridge's `LX` Bluetooth filter.

## Upstream

https://github.com/cicloid/printable

The deployed site includes the upstream MIT license and embedded-font OFL
license files copied by the build workflow.
