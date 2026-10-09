RivuLog Printer V1.2 — Shared cut lines

FIX
- Continuous Bluetooth batches now have one shared cutting line between adjacent labels.
- Leaves the first label top line and final label bottom line intact.
- Does not change label bitmap dimensions (384 x 300), QR size, or text.
- Single label printing is unchanged and keeps both lines.
- Affects tank labels from RivuLog V5.4.3 only (line at x=8..375, y=5..6).

INSTALL
1. In GitHub repository rivulog-printer, replace index.html and app.js.
2. Commit and wait for GitHub Pages.
3. Fully close/reopen printer bridge (Ctrl+Shift+R if required).
4. Keep Continuous batch selected, Feed lines=0.
5. Print two labels to test.

No change required to Google Apps Script / RivuLog or printer WASM pkg.
