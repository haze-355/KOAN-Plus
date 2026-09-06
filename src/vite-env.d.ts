/// <reference types="vite/client" />

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getURL(path: string): string;
  };
  permissions?: {
    getAll(): Promise<{ data_collection?: string[] }>;
    request(details: { data_collection: string[] }): Promise<boolean>;
  };
};
