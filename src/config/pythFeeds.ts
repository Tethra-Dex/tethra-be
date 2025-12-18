import { AssetConfig } from '../types';

const PYTH_FEEDS_JSON_KEY = 'PYTH_FEEDS';
const PYTH_FEED_PREFIX = 'PYTH_FEED_';

function normalizeSymbol(input: string): string {
  return input.trim().toUpperCase();
}

export function normalizePythPriceId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  const normalized = withPrefix.toLowerCase();

  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return null;
  return normalized;
}

type StringMap = Record<string, string>;

function parsePythFeedsJson(value: string): { feeds: StringMap; warnings: string[] } {
  const warnings: string[] = [];
  const feeds: StringMap = {};

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(
        `${PYTH_FEEDS_JSON_KEY} must be a JSON object like {"BTC":"0x...","ETH":"0x..."}`
      );
      return { feeds, warnings };
    }

    for (const [rawSymbol, rawId] of Object.entries(parsed as Record<string, unknown>)) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) continue;

      if (rawId === null) {
        feeds[symbol] = '';
        continue;
      }

      if (typeof rawId !== 'string') {
        warnings.push(`${PYTH_FEEDS_JSON_KEY}.${symbol} must be a string (price id)`);
        continue;
      }

      feeds[symbol] = rawId;
    }

    return { feeds, warnings };
  } catch (error) {
    warnings.push(
      `Failed to parse ${PYTH_FEEDS_JSON_KEY} as JSON: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    return { feeds, warnings };
  }
}

export function resolvePythAssetsFromEnv(
  defaultAssets: AssetConfig[],
  env: NodeJS.ProcessEnv
): { assets: AssetConfig[]; warnings: string[]; usedCustomFeeds: boolean } {
  const warnings: string[] = [];

  const symbolToAsset = new Map<string, AssetConfig>();
  for (const asset of defaultAssets) {
    symbolToAsset.set(normalizeSymbol(asset.symbol), { ...asset });
  }

  const providedSymbols = new Set<string>();

  const pythFeedsJson = env[PYTH_FEEDS_JSON_KEY];
  if (typeof pythFeedsJson === 'string' && pythFeedsJson.trim()) {
    const parsed = parsePythFeedsJson(pythFeedsJson);
    warnings.push(...parsed.warnings);

    for (const [symbol, rawId] of Object.entries(parsed.feeds)) {
      providedSymbols.add(symbol);
      if (!rawId || !rawId.trim()) {
        symbolToAsset.delete(symbol);
        continue;
      }

      const normalizedId = normalizePythPriceId(rawId);
      if (!normalizedId) {
        warnings.push(
          `${PYTH_FEEDS_JSON_KEY}.${symbol} is not a valid Pyth price id (expected 32-byte hex like 0x...)`
        );
        continue;
      }

      const existing = symbolToAsset.get(symbol);
      symbolToAsset.set(symbol, existing ? { ...existing, pythPriceId: normalizedId } : { symbol, pythPriceId: normalizedId });
    }
  }

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(PYTH_FEED_PREFIX)) continue;

    const rawSymbol = key.slice(PYTH_FEED_PREFIX.length);
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) continue;

    providedSymbols.add(symbol);

    const value = typeof rawValue === 'string' ? rawValue : '';
    if (!value.trim()) {
      symbolToAsset.delete(symbol);
      continue;
    }

    const normalizedId = normalizePythPriceId(value);
    if (!normalizedId) {
      warnings.push(
        `${key} is not a valid Pyth price id (expected 32-byte hex like 0x...)`
      );
      continue;
    }

    const existing = symbolToAsset.get(symbol);
    symbolToAsset.set(symbol, existing ? { ...existing, pythPriceId: normalizedId } : { symbol, pythPriceId: normalizedId });
  }

  const assets = Array.from(symbolToAsset.values());
  if (assets.length === 0) {
    warnings.push(
      `No Pyth feeds configured (env overrides removed everything); falling back to default assets`
    );
    return { assets: defaultAssets.map(a => ({ ...a })), warnings, usedCustomFeeds: false };
  }

  // Detect duplicate feed ids (helps avoid confusing mapping)
  const feedIdToSymbols = new Map<string, string[]>();
  for (const asset of assets) {
    const normalizedId = normalizePythPriceId(asset.pythPriceId);
    if (!normalizedId) continue;
    const list = feedIdToSymbols.get(normalizedId) || [];
    list.push(asset.symbol);
    feedIdToSymbols.set(normalizedId, list);
  }
  for (const [id, symbols] of feedIdToSymbols.entries()) {
    if (symbols.length > 1) {
      warnings.push(`Multiple symbols share the same Pyth price id ${id}: ${symbols.join(', ')}`);
    }
  }

  const usedCustomFeeds = providedSymbols.size > 0;
  return { assets, warnings, usedCustomFeeds };
}

