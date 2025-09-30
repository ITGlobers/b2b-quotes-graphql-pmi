import {
  APP_NAME,
  B2B_USER_DATA_ENTITY,
  B2B_USER_SCHEMA_VERSION,
  QUOTE_DATA_ENTITY,
  QUOTE_FIELDS,
  SCHEMA_VERSION,
} from '../../constants'
import GraphQLError from '../../utils/GraphQLError'
import { checkConfig } from '../utils/checkConfig'
import SellerQuotesController from '../utils/sellerQuotesController'

const TOP_N = 10
const DEFAULT_PER_PAGE = 15
const DEFAULT_MAX_ORDERS = 60
const SUGGESTED_CACHE_ENTITY = 'suggested_quotes_cache'
const CACHE_TTL_HOURS = 24

async function getTopSkusFromCache(ctx: Context, userKey: string) {
  const { masterdata } = ctx.clients as any
  try {
    const cacheResults = await masterdata.searchDocuments({
      dataEntity: SUGGESTED_CACHE_ENTITY,
      fields: ['id', 'items', 'cachedAt'],
      page: 1,
      pageSize: 1,
      where: `userKey=${userKey}`,
    })

    if (cacheResults.length > 0) {
      const { items, cachedAt} = cacheResults[0]
      const cacheAge = Date.now() - new Date(cachedAt).getTime()
      const cacheExpired = cacheAge > (CACHE_TTL_HOURS * 60 * 60 * 1000)

      if (!cacheExpired && items) {
        return JSON.parse(items)
      }
    }
  } catch (error) {
    ctx.vtex?.logger?.warn({ msg: 'Failed to get cached suggestions', userKey, error })
  }
  return null
}

async function saveCache(ctx: Context, userKey: string, items: any[]) {
  const { masterdata } = ctx.clients as any
  try {
    const existing = await masterdata.searchDocuments({
      dataEntity: SUGGESTED_CACHE_ENTITY,
      fields: ['id'],
      page: 1,
      pageSize: 1,
      where: `userKey=${userKey}`,
    })

    const cacheData = {
      cachedAt: new Date().toISOString(),
      items: JSON.stringify(items),
      userKey,
    }

    if (existing.length > 0) {
      await masterdata.updatePartialDocument({
        dataEntity: SUGGESTED_CACHE_ENTITY,
        fields: cacheData,
        id: existing[0].id,
      })
    } else {
      await masterdata.createDocument({
        dataEntity: SUGGESTED_CACHE_ENTITY,
        fields: cacheData,
      })
    }
  } catch (error) {
    ctx.vtex?.logger?.warn({ msg: 'Failed to cache suggestions', userKey, error })
  }
}

async function computeTopSkus(ctx: Context, userKey: string, topN: number) {
  const { oms } = ctx.clients
  const authCookie = ctx.vtex.authToken || ctx.cookies?.get('VtexIdclientAutCookie') || ''
  let page = 1
  let fetched = 0
  const qtyBySku = new Map<string, {
    qty: number
    lastPurchasedAt?: string
    itemData: any
  }>()

  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const dateFilter = ninetyDaysAgo.toISOString().split('T')[0]

  while (fetched < DEFAULT_MAX_ORDERS) {
    const params: any = {
      f_clientEmail: userKey.includes('@') ? userKey : undefined,
      f_creationDate: `creationDate:[${dateFilter} TO *]`,
      orderBy: 'creationDate,desc',
      page,
      per_page: DEFAULT_PER_PAGE,
    }

    const list = await oms.listOrders(authCookie, params)
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

      const full = await oms.getOrder(orderId, authCookie)
      const items: any[] = full?.items || []
      const createdAt: string | undefined = full?.creationDate || o?.creationDate

      for (const it of items) {
        const skuId = String(it.id ?? it.skuId ?? '')
        const quantity = Number(it.quantity || 0)

        if (!skuId || !quantity) {
          continue
        }

        const prev = qtyBySku.get(skuId) || {
          itemData: null,
          qty: 0,
        }

        const lastPurchasedAt =
            createdAt && (!prev.lastPurchasedAt || createdAt > prev.lastPurchasedAt)
                ? createdAt
                : prev.lastPurchasedAt

        const itemData = prev.itemData || {
          id: skuId,
          imageUrl: it.imageUrl || '',
          listPrice: Number(it.listPrice || it.price || it.sellingPrice || 0) / 100,
          name: it.name || it.skuName || `Product ${skuId}`,
          price: Number(it.price || it.sellingPrice || 0) / 100,
          productId: it.productId || skuId,
          refId: it.refId || '',
          seller: it.seller || '1',
          sellingPrice: Number(it.sellingPrice || it.price || 0) / 100,
          skuName: it.skuName || it.name || `SKU ${skuId}`,
        }

        qtyBySku.set(skuId, {
          itemData,
          lastPurchasedAt,
          qty: prev.qty + quantity,
        })
      }

      fetched++
    }

    if (orders.length < DEFAULT_PER_PAGE) {
      break
    }

    page++
  }

  const result = Array.from(qtyBySku.entries())
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, topN)
      .map(([skuId, v]) => ({
        itemData: v.itemData,
        lastPurchasedAt: v.lastPurchasedAt,
        qty: v.qty,
        skuId,
      }))

  return result
}

// This function checks if given email is an user part of a buyer org.
export const isUserPartOfBuyerOrg = async (email: string, ctx: Context) => {
  const {
    clients: { masterdata },
  } = ctx

  const where = `email=${email}`
  const resp = await masterdata.searchDocumentsWithPaginationInfo({
    dataEntity: B2B_USER_DATA_ENTITY,
    fields: ['id'], // we don't need to fetch all fields, only if there is an entry or not
    pagination: {
      page: 1,
      pageSize: 1, // we only need to know if there is at least one user entry
    },
    schema: B2B_USER_SCHEMA_VERSION,
    ...(where ? { where } : {}),
  })

  const { data } = (resp as unknown) as {
    data: any
  }

  if (data.length > 0) {
    return true
  }

  return false
}

const buildWhereStatement = async ({
  permissions,
  organization,
  costCenter,
  status,
  search,
  userOrganizationId,
  userCostCenterId,
  userSalesChannel,
}: {
  permissions: string[]
  organization?: string[]
  costCenter?: string[]
  status?: string[]
  search?: string
  userOrganizationId: string
  userCostCenterId: string
  userSalesChannel?: string
}) => {
  // only the main quotes must be fetched
  const whereArray = ['(parentQuote is null)']

  // if user only has permission to access their organization's quotes,
  // hard-code that organization into the masterdata search
  if (!permissions.includes('access-quotes-all')) {
    whereArray.push(`organization=${userOrganizationId}`)
  } else if (organization?.length) {
    const orgArray = organization.map((org) => `organization=${org}`)
    const organizationsStatement = `(${orgArray.join(' OR ')})`

    whereArray.push(organizationsStatement)
  }

  // similarly, if user only has permission to see their cost center's quotes,
  // hard-code its ID into the search
  if (
    !permissions.includes('access-quotes-all') &&
    !permissions.includes('access-quotes-organization')
  ) {
    whereArray.push(`costCenter=${userCostCenterId}`)
  } else if (costCenter?.length) {
    const ccArray = costCenter.map((cc) => `costCenter=${cc}`)
    const costCenters = `(${ccArray.join(' OR ')})`

    whereArray.push(costCenters)
  }

  // similarly, if user only has permission to see their quotes from their sales channel,
  // hard-code its value into the search
  // allow all users to view quotes without a sales channel
  if (
    !permissions.includes('access-quotes-all') &&
    !permissions.includes('access-quotes-all-saleschannel') &&
    userSalesChannel
  ) {
    whereArray.push(
      `((salesChannel is null) OR salesChannel="${userSalesChannel}")`
    )
  }

  if (status?.length) {
    const statusArray = status.map((stat) => `status=${stat}`)
    const statuses = `(${statusArray.join(' OR ')})`

    whereArray.push(statuses)
  }

  if (search) {
    const searchArray = [] as string[]

    searchArray.push(`referenceName="*${search}*"`)
    searchArray.push(`creatorEmail="*${search}*"`)
    const searches = `(${searchArray.join(' OR ')})`

    whereArray.push(searches)
  }

  return whereArray.join(' AND ')
}

export const Query = {
  getQuote: async (_: any, { id }: { id: string }, ctx: Context) => {
    const {
      clients: { masterdata },
      vtex,
      vtex: { logger },
    } = ctx

    const { sessionData, storefrontPermissions, segmentData } = vtex as any

    if (
      !storefrontPermissions?.permissions?.length ||
      !sessionData?.namespaces['storefront-permissions']?.organization?.value ||
      !sessionData?.namespaces['storefront-permissions']?.costcenter?.value
    ) {
      return null
    }

    const { permissions } = storefrontPermissions
    const userOrganizationId =
      sessionData.namespaces['storefront-permissions'].organization.value

    const userCostCenterId =
      sessionData.namespaces['storefront-permissions'].costcenter.value

    const userSalesChannel = segmentData?.channel

    if (
      !permissions.some(
        (permission: string) => permission.indexOf('access-quotes') >= 0
      )
    ) {
      return null
    }

    await checkConfig(ctx)

    try {
      const quote: Quote = await masterdata.getDocument({
        dataEntity: QUOTE_DATA_ENTITY,
        fields: QUOTE_FIELDS,
        id,
      })

      // if user only has permission to view their organization's quotes, check that the org matches
      if (
        !permissions.includes('access-quotes-all') &&
        permissions.includes('access-quotes-organization') &&
        userOrganizationId !== quote.organization
      ) {
        return null
      }

      // if user only has permission to view their cost center's quotes, check that the cost center matches
      if (
        !permissions.includes('access-quotes-all') &&
        !permissions.includes('access-quotes-organization') &&
        userCostCenterId !== quote.costCenter
      ) {
        return null
      }

      // if user only has permission to view quotes from their sales channel, check that the sales channel matches or is null
      if (
        !permissions.includes('access-quotes-all') &&
        !permissions.includes('access-quotes-all-saleschannel') &&
        quote.salesChannel &&
        userSalesChannel !== quote.salesChannel
      ) {
        return null
      }

      return quote
    } catch (error) {
      logger.error({
        error,
        message: 'getQuote-error',
      })
      if (error.message) {
        throw new GraphQLError(error.message)
      } else if (error.response?.data?.message) {
        throw new GraphQLError(error.response.data.message)
      } else {
        throw new GraphQLError(error)
      }
    }
  },
  getQuotes: async (
    _: any,
    {
      organization,
      costCenter,
      status,
      search,
      page,
      pageSize,
      sortOrder,
      sortedBy,
    }: {
      organization: string[]
      costCenter: string[]
      status: string[]
      search: string
      page: number
      pageSize: number
      sortOrder: string
      sortedBy: string
    },
    ctx: Context
  ) => {
    const {
      clients: { masterdata },
      vtex,
      vtex: { logger },
    } = ctx

    const { sessionData, storefrontPermissions, segmentData } = vtex as any

    if (
      !storefrontPermissions?.permissions?.length ||
      !sessionData?.namespaces['storefront-permissions']?.organization?.value ||
      !sessionData?.namespaces['storefront-permissions']?.costcenter?.value
    ) {
      return null
    }

    const { permissions } = storefrontPermissions
    const userOrganizationId =
      sessionData.namespaces['storefront-permissions'].organization.value

    const userCostCenterId =
      sessionData.namespaces['storefront-permissions'].costcenter.value

    if (
      !permissions.some(
        (permission: string) => permission.indexOf('access-quotes') >= 0
      )
    ) {
      return null
    }

    const userSalesChannel = segmentData?.channel

    await checkConfig(ctx)

    const where = await buildWhereStatement({
      permissions,
      organization,
      costCenter,
      status,
      search,
      userOrganizationId,
      userCostCenterId,
      userSalesChannel,
    })

    try {
      return await masterdata.searchDocumentsWithPaginationInfo({
        dataEntity: QUOTE_DATA_ENTITY,
        fields: QUOTE_FIELDS,
        pagination: { page, pageSize },
        schema: SCHEMA_VERSION,
        sort: `${sortedBy} ${sortOrder}`,
        ...(where && { where }),
      })
    } catch (error) {
      logger.error({
        error,
        message: 'getQuotes-error',
      })
      throw new GraphQLError(error)
    }
  },
  getChildrenQuotes: async (
    _: any,
    {
      id,
      sortOrder,
      sortedBy,
    }: {
      id: string
      sortOrder: string
      sortedBy: string
    },
    ctx: Context
  ) => {
    const {
      vtex: { logger },
    } = ctx

    await checkConfig(ctx)
    const sellerQuotesController = new SellerQuotesController(ctx)

    try {
      return await sellerQuotesController.getAllChildrenQuotes(
        id,
        sortOrder,
        sortedBy
      )
    } catch (error) {
      logger.error({
        error,
        message: 'getQuotes-error',
      })
      throw new GraphQLError(error)
    }
  },
  getQuoteEnabledForUser: async (
    _: any,
    { email }: { email: string },
    ctx: Context
  ) => {
    const {
      vtex: { logger },
    } = ctx

    try {
      // if user is part of a buyer org, quote functionality is enabled
      return await isUserPartOfBuyerOrg(email, ctx)
    } catch (error) {
      logger.error({
        error,
        message: 'getQuoteEnabledForUser-error',
      })
      throw new GraphQLError(error)
    }
  },
  getAppSettings: async (_: void, __: void, ctx: Context) => {
    const {
      clients: { vbase },
      vtex: { logger },
    } = ctx

    await checkConfig(ctx)
    let settings = null

    try {
      settings = await vbase.getJSON<Settings | null>(
        APP_NAME,
        'settings',
        true
      )
    } catch (error) {
      logger.error({
        error,
        message: 'getAppSettings-getVbaseError',
      })

      return null
    }

    if (settings && !settings?.adminSetup.quotesManagedBy) {
      settings.adminSetup.quotesManagedBy = 'MARKETPLACE'
    }

    return settings
  },
  checkSellerQuotes: async (
    _: void,
    { sellers }: { sellers: string[] },
    ctx: Context
  ) => {
    // guarantee at least the marketplace seller to use your name if necessary
    const allSellers = sellers.filter((seller) => seller !== '1')

    allSellers.push('1')

    const verifiedSellers = await Promise.all(
      allSellers.map(async (seller) => {
        if (seller === '1') {
          return ctx.clients.seller.getSeller(seller)
        }

        const verifyResponse = await ctx.clients.sellerQuotes
          .verifyQuoteSettings(seller)
          .catch(() => null)

        if (verifyResponse?.receiveQuotes) {
          return ctx.clients.seller.getSeller(seller)
        }

        return null
      })
    )

    return verifiedSellers.filter(Boolean)
  },
  generateQuoteSuggestion: async (_: unknown, args: any, ctx: Context) => {
    try {
      const { input } = args || {}
      const { sessionData, storefrontPermissions } = ctx.vtex as any

      const profileEmail = sessionData?.namespaces?.profile?.email?.value
      const adminEmail = sessionData?.namespaces?.authentication?.adminUserEmail?.value
      const email = profileEmail || adminEmail

      if (!email) {
        throw new Error('Not authenticated: missing user email in session')
      }

      const isAdminUser = !!adminEmail
      const hasCreateQuotesPermission = storefrontPermissions?.permissions?.includes('create-quotes')

      if (!isAdminUser && !hasCreateQuotesPermission) {
        throw new Error('operation-not-permitted')
      }

      const userKey = email
      const topN = Number(input?.topN ?? TOP_N)

      let topItems = await getTopSkusFromCache(ctx, userKey).catch((err) => {
        ctx.vtex?.logger?.warn({ msg: 'Cache fetch failed', userKey, error: err.message })
        return null
      })

      if (!topItems) {
        try {
          topItems = await computeTopSkus(ctx, userKey, topN)
          await saveCache(ctx, userKey, topItems).catch(() => undefined)
        } catch (error) {
          ctx.vtex?.logger?.error({
            error: (error as any).message,
            msg: 'Failed to compute top SKUs',
            status: (error as any).response?.status,
            statusText: (error as any).response?.statusText,
            userKey,
          })
          throw new Error(`Failed to fetch order history: ${(error as any).message}`)
        }
      }

      if (!topItems?.length) {
        throw new Error('No items found for suggested quote')
      }

      const items = topItems.map((i: any) => ({
        ...i.itemData,
        quantity: Number(i.qty),
      }))

      return { items }
    } catch (error) {
      ctx.vtex?.logger?.error({
        error: (error as any).message,
        msg: 'generateQuoteSuggestion failed',
      })
      throw error
    }
  },
}
