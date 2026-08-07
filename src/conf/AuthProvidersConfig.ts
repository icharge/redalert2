export interface AuthProvider {
    id: string;
    loginUrl: string;
}

export class AuthProvidersConfig {
    private providers: AuthProvider[] = [];

    load(section: any, gatewayConfig: any): void {
        this.providers = [];
        if (!section) {
            return;
        }
        for (const providerSection of section.getOrderedSections()) {
            if (providerSection.getBool("enabled")) {
                const id = providerSection.name;
                this.providers.push({
                    id,
                    loginUrl: providerSection.getString("loginUrl") || gatewayConfig.getAuthProviderLoginUrl(id),
                });
            }
        }
    }

    getAll(): AuthProvider[] {
        return [...this.providers];
    }
}
