# Zenji Cards (holiday)

Interactive cards people send as a link: birthdays, Eid, love, apologies, thank-yous, a year in review, certificates, countdowns and quizzes. Buyers make a card in under two minutes, pay, and share the link. Each card shows a small "Made with Zenji Cards" line, so every card advertises the next one.

The site runs on **GitHub Pages**: https://bindosi.github.io/holiday/

Card content and payments run on the **Zenjishoppazz server** (`/api/cards`, in `Bindosi/backend-web`), using the shop's Flutterwave account.

## The cards

| Folder | Card | What happens |
|---|---|---|
| `birthday/` | Blow out the candles | Shake the phone (or tap) to blow out the candles, then the message appears. Old free links like `birthday/#Mkali-5` still work. |
| `eid/` | Light the lanterns | Shake or tap to light five lanterns over Stone Town, then the Eid wishes appear. Greetings: Eid Mubarak, Idd Mubarak, Eid al-Fitr, Eid al-Adha, Ramadan Kareem. |
| `ask-out/` | The big question | "Will you go out with me?" (or any question). The No button runs away. Yes shows your message, when and where. |
| `sorry/` | A garden of sorry | Apology lines appear one at a time as they scroll, while flowers grow. Ends with "Will you forgive me?". |
| `thank-you/` | Pop the balloons | Each balloon hides one reason. Pop them all for the thank-you note. |
| `year-review/` | Our year in review | Story-style slides: funniest moment, best trip, inside joke and more, with up to 3 photos. |
| `certificate/` | Official certificate | "World's Okayest Dad" and other awards. Save as image, or print / save as PDF. |
| `countdown/` | Countdown | Live days, hours, minutes and seconds to a date, or since a date. Optional photo, confetti at zero, and an option to remove the branding. |
| `quiz/` | How well do you know me? | Friends answer, get a score, and appear on a leaderboard. The right answers stay on the server. |
| `packs/` | 5-card pack | One payment, a code worth 5 cards. |

## How a sale works

1. The buyer opens a card page, fills in the form and watches the live preview.
2. They tap **Get my link** and choose how to pay:
   - **Tanzania, TSh 2,000:** M-Pesa, Mixx by Yas, Airtel Money or card.
   - **Anywhere, $0.99:** card, Apple Pay or Google Pay.
   - **A pack code:** uses one of the pack's cards.
3. Flutterwave's payment page opens, then sends them back. The server checks the payment with Flutterwave (amount, currency, reference) before the card goes live.
4. They get the link, with WhatsApp and share buttons. The card stays online for a year.

The cards a buyer made on a phone are listed under **My cards** on the home page of that phone. Prices are set on the server in `config/cards.php`.

## Files

```
index.html          home: all cards, packs, "My cards"
assets/zc.js        shared engine: form, live preview, payment, sharing, viewer, confetti, sound, shake
assets/zc.css       shared look of the forms and sheets
<card>/index.html   one card: its fields, and how it draws and plays
packs/index.html    buy a 5-card pack
```

To add a card type:
1. Copy a card folder.
2. Change `type`, `fields` and `render()`.
3. Add the type to `config/cards.php` on the server and to the list in `index.html`.

## Testing locally

Run the backend with `CARDS_TEST_MODE=true` (payments are skipped), then serve this folder:

```bash
python3 -m http.server 8766
# open http://localhost:8766/birthday/?api=http://localhost:8000/api/cards
```

The `?api=` switch only works on `localhost`. The real site always uses `https://admin.zenjishoppazz.com/api/cards`.
