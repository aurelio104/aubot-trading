# AuBot Trading v0.2

Motor de trading Binance: múltiples estrategias, decision engine con 15+ gates, contexto BTC unificado.

## API REST

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |
| GET | `/status` | — | Motor + estrategia + posición |
| GET | `/stats` | — | Riesgo, PnL día, grid |
| GET | `/analysis` | — | Ranking pares + `btcContext` |
| GET | `/market-context` | — | Contexto BTC (gates unificados) |
| GET | `/decision` | — | Motor de decisión |
| GET | `/regime` | — | Régimen mercado |
| GET | `/news` | — | Fear & Greed + RSS |
| GET | `/scorecard?days=` | — | Scorecard + aprendizaje |
| GET | `/trades?days=` | — | Trades cerrados |
| GET | `/lecciones?limit=` | — | Lecciones |
| GET | `/logs?limit=` | — | Logs |
| GET | `/account` | — | Balances |
| GET | `/wallets` | — | Spot + Fondos |
| GET | `/price?symbol=` | — | Precio ticker |
| GET | `/orders?symbol=` | — | Órdenes abiertas |
| POST | `/control` | token | start, stop, pause, sync_position, apply_learning… |
| POST | `/order` | token | `{ side, quantity \| quoteOrderQty, symbol? }` |
| POST | `/consolidate` | token | Liquidar alts → USDT |
| POST | `/earn/redeem` | token | Redeem Simple Earn |
| POST | `/transfer` | token | MAIN_FUNDING / FUNDING_MAIN |

Auth: header `X-AuBot-Token` si `AUBOT_CONTROL_TOKEN` está definido.

## Contexto BTC unificado

```env
AUBOT_BTC_REFERENCE=true          # Siempre analiza BTC como referencia
AUBOT_UNIFIED_BTC_GATES=true      # Mismos gates para BTC y todos los alts
AUBOT_CANDIDATE_SYMBOLS=ADAUSDT;DOGEUSDT;SOLUSDT;LINKUSDT;AVAXUSDT
```

Si BTC no es asequible (~20 USDT), el motor opera el mejor alt con **idénticas reglas** de régimen, F&G, noticias y fee-first.

## Estrategias (`AUBOT_STRATEGY`)

| Valor | Descripción |
|-------|-------------|
| `threshold` | Compra/vende por umbral de precio |
| `dca` | Compra periódica en USDT |
| `mean_reversion` | RSI + Bollinger (default capital mode) |
| `grid` | Grid spot LIMIT |

## Tests

```bash
npm ci
npm run build
npm test
```

## Backtest offline

```bash
npm run build
npm run backtest
```
