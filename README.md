# EngLint

A linter for English. EngLint is a Chrome and Brave extension that checks your writing as you type, in any text box, in rich editors such as Gmail, and in Google Docs. It runs on your own AI key, and you choose the provider.

## Features

- **Live checks as you type:** spelling, grammar, punctuation and word choice, plus clarity, engagement and delivery suggestions. Accept or dismiss each one from a card under the underline.
- **Writing modes:**
  - **Essay:** careful, comment-first;
  - **Standard;**
  - **Casual.**

  Set them per site. Google Docs and the Common App open in Essay mode.
- **Instant local checks:** [Harper](https://writewithharper.com) runs on your computer as WebAssembly, so common mistakes show at once and that text never leaves your machine. Generic-phrasing detection also runs locally.
- **Rewrite tools:** select text and press Ctrl+Shift+E, or right-click, to get:
  - rewrites in several tones;
  - synonyms;
  - "Sound like me", which removes generic phrasing in your own voice;
  - follow-up questions about any result.
- **Side panel:**
  - every issue in the field;
  - a chat about your writing;
  - **Review:** document stats and tone, reader reactions, a grader that scores against a rubric you paste, a whole-text deep check, and a citation finder (on Claude, using web search).
- **Learns from you:**
  - **Personal dictionary.**
  - **"Stop suggesting" rules:** set per mode. After you dismiss the same kind of suggestion three times, EngLint offers to stop it.
  - **Style profile:** opt-in. Rewrites and synonyms use it to sound like you.
- **Any provider:**
  - **Claude:** the default; EngLint is tuned and tested on it.
  - **Any OpenAI-compatible provider:** OpenAI, Google Gemini, OpenRouter, Groq, Ollama, LM Studio, or a custom endpoint.
- **Spending:** costs come from each response's real token usage. A monthly limit pauses live checks when it's reached.

## Privacy

- **Your key:** it lives only in the extension's background worker. Web pages and content scripts never see it. A key is sent only to the provider it was saved for.
- **Your text:** it goes only to the provider you chose, and only to check it. Harper's checks stay on your computer.
- **No tracking:** EngLint sends no telemetry and keeps no log of your typing.

## Install from source

You need Node.js and npm.

```bash
npm install
npm run build
```

Then open `chrome://extensions` (or `brave://extensions`), turn on Developer mode, click **Load unpacked**, and choose `.output/chrome-mv3`. Open EngLint's settings to add your API key.

## Development

```bash
npm run dev        # build and reload while you work
npm test           # unit tests (Vitest)
npm run typecheck  # TypeScript
npm run e2e        # end-to-end tests (Playwright, against a local mock API)
```

The evals in `evals/` measure suggestion quality against the real Claude API. They read `ANTHROPIC_API_KEY` from a local `.env` file, and each run costs a little money.

## License

MIT. See [LICENSE](LICENSE). Third-party notices are in [public/NOTICE.txt](public/NOTICE.txt).
