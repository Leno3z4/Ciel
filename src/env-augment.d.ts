declare module "./index" {
  interface Env {
    GEMINI_API_KEY_3?: string;
    GEMINI_API_KEY_4?: string;
    GEMINI_API_KEY_5?: string;
    GEMINI_API_KEY_6?: string;
    GEMINI_API_KEY_7?: string;
  }
}

declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}
