RivuLog Printer v1.1 — Continuous Batch Printing

Contents of this ZIP:
  index.html  — replace index.html in GitHub repo rivulog-printer
  app.js      — replace app.js in the SAME repo

Keep the existing pkg/ folder and printer WASM engine untouched.

Changes:
 - Default Feed lines after last label: 0 (the zero value now works).
 - Continuous batch checked by default: compose a single 384-dot-wide PNG
   with the labels directly touching and print it with one WasmJob.
 - Individual-job fallback can be selected by unchecking Continuous batch.
 - Existing Web Bluetooth setup, label reception, label rasterization,
   printer result messages, and printer diagnostics preserved.

Testing:
 1. Update both repository files and wait until Pages deployment is finished.
 2. Close existing printer window, hard-refresh Apps Script and open batch
    print for 2 labels from RivuLog V5.4.3.
 3. Verify Continuous batch ON, Feed lines 0, then print.
 4. Inspect printed strip and scan QR codes.

Warnings:
 - If a print job fails partway, some labels may have already been printed.
   Inspect the strip before retrying so you don't duplicate labels.
 - Hardware behavior cannot be verified without a live LX-D02 printer.
 - Very large continuous batches may use more memory/time than before;
   the Individual-jobs option remains available as a fallback.
