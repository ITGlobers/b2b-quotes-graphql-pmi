import type { ParamsContext } from '@vtex/api'
import type { Clients } from '../clients'

type Ctx = ParamsContext & { clients: Clients; vtex: any }

const TOP_N = 10
const DEFAULT_PER_PAGE = 15
const DEFAULT_MAX_ORDERS = 60
const DATA_ENTITY = 'SC'

async function getTopSkusFromCache(ctx: Ctx, userKey: string) {
    const { masterdata } = ctx.clients as any
    const res = await masterdata.searchDocuments({
        dataEntity: DATA_ENTITY,
        fields: ['id', 'items', 'ttlUntil'],
        pagination: { page: 1, pageSize: 1 },
        where: `userKey=${userKey}`,
    })
    const hit = res?.[0]
    if (hit?.ttlUntil && new Date(hit.ttlUntil) > new Date()) {
        return hit.items ?? []
    }
    return null
}

async function saveCache(ctx: Ctx, userKey: string, items: any[]) {
    const { masterdata } = ctx.clients as any
    const ttlUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await masterdata.createOrUpdateEntireDocument({
        dataEntity: DATA_ENTITY,
        fields: { userKey, items, ttlUntil },
    })
}

async function computeTopSkus(ctx: Ctx, userKey: string, topN: number) {
    const { oms } = ctx.clients
    let page = 1
    let fetched = 0
    const qtyBySku = new Map<string, { qty: number; lastPurchasedAt?: string }>()

    while (fetched < DEFAULT_MAX_ORDERS) {
        const params: any = {
            f_clientEmail: userKey.includes('@') ? userKey : undefined,
            orderBy: 'creationDate,desc',
            page,
            per_page: DEFAULT_PER_PAGE,
        }
        const list = await oms.listOrders(params)
        const orders: any[] = list?.list || list?.orders || []
        if (!orders.length) {
            break
        }

        for (const o of orders) {
            if (fetched >= DEFAULT_MAX_ORDERS) {
                break
            }

            const orderId = o.orderId || o.orderIdFormatted || o.orderIdClean
            if (!orderId) {
                continue
            }

            const full = await oms.getOrder(orderId)
            const items: any[] = full?.items || []
            const createdAt: string | undefined = full?.creationDate || o?.creationDate

            for (const it of items) {
                const skuId = String(it.id ?? it.skuId ?? '')
                const quantity = Number(it.quantity || 0)

                if (!skuId || !quantity) {
                    continue
                }

                const prev = qtyBySku.get(skuId) || { qty: 0 }
                const lastPurchasedAt =
                    createdAt && (!prev.lastPurchasedAt || createdAt > prev.lastPurchasedAt)
                        ? createdAt
                        : prev.lastPurchasedAt

                qtyBySku.set(skuId, { qty: prev.qty + quantity, lastPurchasedAt })
            }

            fetched++
        }

        if (orders.length < DEFAULT_PER_PAGE) {
            break
        }

        page++
    }

    return Array.from(qtyBySku.entries())
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, topN)
        .map(([skuId, v]) => ({ skuId, qty: v.qty, lastPurchasedAt: v.lastPurchasedAt }))
}

export const Mutation = {
    // createSuggestedQuote(input: CreateSuggestedQuoteInput!): Quote!
    createSuggestedQuote: async (_: any, args: any, ctx: Ctx) => {
        const { input } = args
        const userKey = String(input.userKey || '').toLowerCase().trim()
        const topN = Number(input.topN ?? TOP_N)

        if (!userKey) {
            throw new Error('Missing input.userKey')
        }

        let topItems = await getTopSkusFromCache(ctx, userKey).catch(() => null)
        if (!topItems) {
            topItems = await computeTopSkus(ctx, userKey, topN)
            await saveCache(ctx, userKey, topItems).catch(() => undefined)
        }

        if (!topItems.length) {
            throw new Error('No items found for suggested quote')
        }

        const quoteItems = topItems.map((i: any) => ({
            id: String(i.skuId),
            quantity: Number(i.qty),
        }))

        const { mutations } = (ctx as any).graphql || {}
        if (!mutations?.createQuote) {
            throw new Error('createQuote resolver not available to be reused')
        }

        const createInput = {
            items: quoteItems,
            note: input.note,
            referenceName: input.referenceName ?? 'Suggested Order',
            sendToSalesRep: Boolean(input.sendToSalesRep),
        }

        const created = await mutations.createQuote(_, { input: createInput }, ctx)
        return created // tipo Quote
    },
}
