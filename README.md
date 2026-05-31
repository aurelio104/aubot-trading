# AuBot Trading v0.2

Motor de trading Binance con **múltiples estrategias**, gestión de riesgo y grid spot.

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Estado motor + estrategia + posición |
| GET | `/stats` | Riesgo, PnL día, grid |
| GET | `/logs?limit=N` | Logs |
| GET | `/account` | Balance Binance |
| GET | `/orders?symbol=` | Órdenes abiertas |
| POST | `/control` | `{ action: start\|stop\|pause }` |
| POST | `/order` | `{ side: BUY\|SELL, quantity, symbol? }` |

## Estrategias (`AUBOT_STRATEGY`)

| Valor | Descripción |
|-------|-------------|
| `threshold` | Compra bajo umbral, vende sobre umbral (default) |
| `dca` | Compra periódica fija en USDT |
| `mean_reversion` | RSI + Bollinger en velas (`AUBOT_KLINE_INTERVAL`) |
| `grid` | Grid spot con órdenes LIMIT |

## Gestión de riesgo (Fase 0)

| Variable | Descripción |
|----------|-------------|
| `AUBOT_STOP_LOSS_PCT` | Stop-loss % desde entrada |
| `AUBOT_TAKE_PROFIT_PCT` | Take-profit % |
| `AUBOT_TRAILING_STOP_PCT` | Trailing stop % desde máximo |
| `AUBOT_MAX_TRADES_PER_DAY` | Límite operaciones/día |
| `AUBOT_MAX_DAILY_LOSS_USDT` | Pausa si pérdida día supera límite |
| `AUBOT_MAX_POSITION_USDT` | Tope notional por compra |
| `AUBOT_COOLDOWN_MS` | Entre trades (default 60000) |

## Variables principales

```env
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=true

AUBOT_SYMBOL=BTCUSDT
AUBOT_TICK_MS=1000
AUBOT_AUTO_START=true
AUBOT_AUTO_TRADE=false
AUBOT_STRATEGY=threshold

# threshold
AUBOT_TRADE_QTY=0.001
AUBOT_BUY_BELOW=50000
AUBOT_SELL_ABOVE=70000
AUBOT_TRAILING_STOP_PCT=3

# dca
AUBOT_DCA_INTERVAL_MS=3600000
AUBOT_DCA_QUOTE_USDT=20

# mean_reversion
AUBOT_KLINE_INTERVAL=15m
AUBOT_RSI_PERIOD=14
AUBOT_RSI_BUY_BELOW=30
AUBOT_RSI_SELL_ABOVE=70
AUBOT_BB_PERIOD=20
AUBOT_BB_STDDEV=2

# grid
AUBOT_GRID_LOWER=90000
AUBOT_GRID_UPPER=110000
AUBOT_GRID_LEVELS=10
AUBOT_GRID_SPACING=arithmetic
AUBOT_GRID_INVESTMENT_USDT=500
AUBOT_GRID_STOP_LOSS_PCT=8
```

## Backtest offline

```bash
npm run backtest -- BTCUSDT 15m 500
```

Sin credenciales para klines públicas. Ver `scripts/aubot-backtest.sh` en guru-asistente.

Gurú: `docs/GURU-AUTONOMIA.md`, `docs/AUBOT-BINANCE-KEYS.md`
