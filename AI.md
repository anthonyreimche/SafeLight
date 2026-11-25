# AI use

Safelight is built by one person with help from AI coding tools. This page says how, so you can judge the work for yourself.

## How Safelight is built

- I use an AI coding assistant, currently Claude Code, to write much of the code, tests and documentation.
- I decide what gets built and how it should behave. Work starts from a bug report, a feature request or my own plan, never from the assistant.
- The behaviour is agreed first, then tests are written that fail, then the code that makes them pass.
- I review, test and run every change before it ships. Changes to how photos look are checked in the app on real photos, not only in tests.
- I build and publish every release, and commits carry my name because I'm responsible for them.

## What keeps the quality up

- Every change runs the test suite on Windows, macOS and Linux, plus GPU rendering tests.
- The source is open under the GPL v3, so anyone can read and check it.
- Bugs are mine to fix. Use **Report an issue** in the app, or [open an issue](https://github.com/anthonyreimche/SafeLight/issues/new/choose).

## Inside the app

The core app has no AI features and sends nothing to AI services. [PRIVACY.md](PRIVACY.md) lists every network request it can make.

Extensions are separate. An extension that uses AI should say so in its description, and say whether your photos leave your computer.

## Contributing with AI

AI-assisted pull requests and extensions are welcome, on the same terms as any other work:

- Understand every line you submit and be ready to explain it.
- Run it and test it before you open the pull request.
- Say in the pull request that AI helped.
