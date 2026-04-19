# spaila-parser

Structured field extraction from EML files with a separated parser engine, desktop app UI, and future backend layer.

## Repository Layout

- `/parser` = parsing engine, learning system, CLI/UI bridge, and parser tests
- `/app` = Electron shell and React UI
- `/backend` = API + DB placeholder for the next phase
- `/shared` = shared placeholder for cross-layer contracts/utilities
- `/tests/samples` = EML fixtures kept at the repo root for existing CLI/test paths

## Usage

```bash
python -m parser.cli path/to/file.eml
```

```bash
py -3 -m parser.ui_bridge parse tests/samples/2353.eml
```

```bash
npm start
```

## Run Tests

```bash
pip install -e ".[dev]"
pytest
```
