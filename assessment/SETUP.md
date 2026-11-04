# Team setup — recording client results

This turns the "auto log" on into your team's Google Sheet, at no cost. Once set up,
every finished assessment writes one row: **timestamp · name · number · band · score ·
confidence · result-code**. The client still gets a fallback share-code if the network
write fails.

## What it is, in plain terms

The website can't write to a sheet on its own (it's just pages). So we put one tiny
"post box" between the two: a free Google Apps Script web app that sits in front of your
Sheet. The quiz POSTs one line to it; it drops the line on the Sheet. No server, no bill.

## One-time setup (about 5 minutes)

1. In Google, make a new Sheet. Add these column headers to row 1:
   `time  ·  name  ·  mobile  ·  band  ·  score  ·  confidence  ·  result_code`
2. Sheet → **Extensions → Apps Script**. Delete the starter line and paste:

   ```js
   function doPost(e) {
     const row = JSON.parse(e.postData.contents);
     const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
     sheet.appendRow([
       row.ts, row.name, row.phone, row.band,
       row.score, row.confidence, row.code
     ]);
     return ContentService
       .createTextOutput(JSON.stringify({ ok: true }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```

3. Click **Save** → **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy. Copy the **Web app URL**.
4. Paste that URL into `assessment/config.json` → `record_endpoint`, commit and push.
   The quiz now auto-logs; the manual code only appears if three writes fail.

The Sheet itself is private (only you and the team can open it). The web-app URL is
public-looking but only accepts writes that match the fields above.

## Reading the log

- **confidence = clean** — normal, trustworthy result.
- **low** — one of the three checks tripped (fast / scattered / one-button). The result
  still shows, but it's worth a human look.
- **needs-review** — two-plus checks tripped and a re-ask didn't fix it. The client was
  pointed at the team instead of a list. Call them.
- **result_code** — base64 of that client's weight profile; open
  `https://blue-ribbon-investment.github.io/fund-selector/?w=<code>` to reproduce their
  exact personalised ranking in the main tool.

## Turning it off / changing bands

- Band → weight tables live in `assessment/config.json` (`bands`), marked
  **pending team review** until you approve them. Change a number there and re-serve;
  nothing else moves.
- To stop auto-logging, set `record_endpoint` back to `""` — clients then just see their
  share-code every time (fully manual).
