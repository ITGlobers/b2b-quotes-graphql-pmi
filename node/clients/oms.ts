import { InstanceOptions, IOContext, JanusClient } from '@vtex/api'

export class OMS extends JanusClient {
    constructor(ctx: IOContext, opts?: InstanceOptions) {
        super(ctx, { ...opts })
    }
    public listOrders(params: Record<string, any>) {
        return this.http.get('/api/oms/pvt/orders', { params })
    }
    public getOrder(orderId: string) {
        return this.http.get(`/api/oms/pvt/orders/${orderId}`)
    }
}
