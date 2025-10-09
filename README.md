# Tethra DEX Backend - Pyth Oracle Price Service

Backend service untuk Tethra DEX yang menyediakan real-time price feeds menggunakan **Pyth Network Oracle**.

## 🌟 Features

- ✅ **Pyth Network Oracle Integration** - Price feeds yang terverifikasi on-chain
- ✅ **Multi-Asset Support** - BTC, ETH, SOL, AVAX, NEAR, BNB, XRP, AAVE, ARB, DOGE, LINK, MATIC
- ✅ **WebSocket Real-time Updates** - Broadcasting harga setiap 5 detik
- ✅ **REST API** - Endpoint untuk get prices, health check
- ✅ **Fallback Mechanism** - Binance API sebagai fallback jika Pyth gagal
- ✅ **TypeScript** - Type-safe development

## 📋 Prerequisites

- Node.js >= 18.x
- npm atau yarn

## 🚀 Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Setup environment variables:**
```bash
cp .env.example .env
```

Edit `.env` sesuai kebutuhan:
```env
PORT=3001
NODE_ENV=development
DEBUG=true
```

## 💻 Development

```bash
npm run dev
```

Server akan running di `http://localhost:3001`

## 🏗️ Build & Production

```bash
# Build TypeScript to JavaScript
npm run build

# Run production
npm start
```

## 📡 API Endpoints

### REST API

#### Get All Prices
```bash
GET http://localhost:3001/api/price/all
```

Response:
```json
{
  "success": true,
  "data": {
    "BTC": {
      "symbol": "BTC",
      "price": 97234.56,
      "confidence": 45.32,
      "expo": -8,
      "timestamp": 1704567890123,
      "source": "pyth",
      "publishTime": 1704567890
    },
    "ETH": { ... },
    ...
  },
  "count": 12,
  "timestamp": 1704567890123
}
```

#### Get Single Asset Price
```bash
GET http://localhost:3001/api/price/current/BTC
```

Response:
```json
{
  "success": true,
  "data": {
    "symbol": "BTC",
    "price": 97234.56,
    "confidence": 45.32,
    "expo": -8,
    "timestamp": 1704567890123,
    "source": "pyth"
  },
  "timestamp": 1704567890123
}
```

#### Health Check
```bash
GET http://localhost:3001/health
```

Response:
```json
{
  "success": true,
  "service": "Tethra DEX Backend",
  "uptime": 123.456,
  "priceService": {
    "status": "connected",
    "lastUpdate": 1704567890123,
    "assetsMonitored": 12
  },
  "timestamp": 1704567890123
}
```

### WebSocket

Connect to: `ws://localhost:3001/ws/price`

**Message Format:**
```json
{
  "type": "price_update",
  "data": {
    "BTC": {
      "symbol": "BTC",
      "price": 97234.56,
      "confidence": 45.32,
      "timestamp": 1704567890123,
      "source": "pyth"
    },
    "ETH": { ... }
  },
  "timestamp": 1704567890123
}
```

## 🔗 Integration dengan Frontend

### WebSocket Client Example (JavaScript/TypeScript)

```typescript
const ws = new WebSocket('ws://localhost:3001/ws/price');

ws.onopen = () => {
  console.log('Connected to Pyth price feed');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.type === 'price_update') {
    const prices = message.data;
    
    // Update your UI with Pyth Oracle prices
    console.log('BTC Price from Pyth:', prices.BTC.price);
    console.log('Confidence:', prices.BTC.confidence);
    
    // Display as yellow line on TradingView chart
    updateChartWithOraclePrice(prices.BTC.price);
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected from price feed');
};
```

### REST API Example (fetch)

```typescript
async function getPythPrices() {
  try {
    const response = await fetch('http://localhost:3001/api/price/all');
    const result = await response.json();
    
    if (result.success) {
      const prices = result.data;
      console.log('All prices from Pyth:', prices);
      return prices;
    }
  } catch (error) {
    console.error('Failed to fetch prices:', error);
  }
}
```

## 📊 Supported Assets

| Symbol | Pyth Price ID | Binance Symbol |
|--------|---------------|----------------|
| BTC    | 0xe62df6... | BTCUSDT |
| ETH    | 0xff61491... | ETHUSDT |
| SOL    | 0xef0d8b6... | SOLUSDT |
| AVAX   | 0x93da335... | AVAXUSDT |
| NEAR   | 0xc415de8... | NEARUSDT |
| BNB    | 0x2f95862... | BNBUSDT |
| XRP    | 0xec5d399... | XRPUSDT |
| AAVE   | 0x2b9ab1e... | AAVEUSDT |
| ARB    | 0x3fa4252... | ARBUSDT |
| DOGE   | 0xdcef50d... | DOGEUSDT |
| LINK   | 0x8ac0c70... | LINKUSDT |
| MATIC  | 0x5de33a9... | MATICUSDT |

## 🛠️ Architecture

```
┌─────────────────────────────────────────┐
│         Pyth Network Oracle             │
│     (Hermes API - hermes.pyth.network)  │
└────────────────┬────────────────────────┘
                 │ Price Feeds (5s interval)
                 ▼
┌─────────────────────────────────────────┐
│      Tethra DEX Backend Service         │
│  ┌───────────────────────────────────┐  │
│  │   PythPriceService                │  │
│  │   - Fetch all assets prices       │  │
│  │   - Fallback to Binance           │  │
│  │   - Real-time updates             │  │
│  └───────────────────────────────────┘  │
│                                          │
│  ┌──────────┐      ┌──────────────┐    │
│  │ REST API │      │  WebSocket   │    │
│  └──────────┘      └──────────────┘    │
└────────────┬─────────────┬──────────────┘
             │             │
             ▼             ▼
┌────────────────────────────────────────┐
│         Frontend Application            │
│  - TradingView Chart                   │
│  - Yellow line for Oracle price        │
│  - Real-time price updates             │
└────────────────────────────────────────┘
```

## 🎯 Next Steps untuk Frontend Integration

1. **Connect WebSocket di Frontend:**
   - Connect ke `ws://localhost:3001/ws/price`
   - Listen for `price_update` messages

2. **Display Oracle Price di Chart:**
   - Ambil price dari Pyth Oracle (via WebSocket)
   - Draw garis kuning horizontal di TradingView chart
   - Update setiap ada price update baru

3. **Show Price Comparison:**
   - Binance price (existing) vs Pyth Oracle price
   - Display confidence interval dari Pyth
   - Show data source indicator

## 📝 Notes

- **Pyth Oracle** menyediakan harga yang cryptographically verified
- Price update interval: **5 detik** (lebih cepat dari TradingView free plan)
- Confidence interval menunjukkan akurasi harga
- Fallback ke Binance jika Pyth tidak available

## 🔧 Troubleshooting

### Port already in use
```bash
# Windows
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:3001 | xargs kill -9
```

### WebSocket connection failed
- Check firewall settings
- Make sure backend is running
- Verify correct URL and port

## 📄 License

MIT

## 👥 Team

Tethra DEX Development Team

# tethra-be