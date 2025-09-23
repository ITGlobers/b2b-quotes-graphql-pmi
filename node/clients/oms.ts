import { InstanceOptions, IOContext, JanusClient } from '@vtex/api'

export class OMS extends JanusClient {
    constructor(ctx: IOContext, opts?: InstanceOptions) {
        super(ctx, { ...opts })
    }

    public listOrders(cookie: string, params: any) {
        return this.http.get('/api/oms/pvt/orders', {
            params,
            headers: { VtexIdclientAutCookie: cookie },
        })
    }

    public getOrder(orderId: string, cookie: string) {
        return this.http.get(`/api/oms/pvt/orders/${orderId}`, {
            headers: { VtexIdclientAutCookie: cookie },
        })
    }
}
