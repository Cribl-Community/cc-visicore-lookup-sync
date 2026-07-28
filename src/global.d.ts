export {};

declare global {
  interface Window {
    /** Base URL for all Cribl API calls, injected by the platform. */
    CRIBL_API_URL: string;
    /** Base path the app is mounted at, injected by the platform. */
    CRIBL_BASE_PATH: string;
    getCriblUser(): Promise<{
      id: string;
      username: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      initials?: string;
    }>;
  }
}
