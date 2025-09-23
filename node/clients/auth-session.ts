// node/clients/auth-session.ts
import { InstanceOptions, IOContext, JanusClient } from '@vtex/api'

export class AuthSessionClient extends JanusClient {
    constructor(ctx: IOContext, opts?: InstanceOptions) {
        super(ctx, { ...opts })
    }

    public getAuthData(cookie: string) {
        return this.http.get('/api/sessions', {
            headers: {
                Cookie: cookie,
            },
            params: {
                items: 'authentication.storeUserId,authentication.storeUserEmail',
            },
        })
    }
}
