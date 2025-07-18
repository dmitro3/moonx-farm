import { toast } from 'react-hot-toast'
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig, AxiosError } from 'axios'

interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  error?: string
}

export interface TokenSearchParams {
  q: string
  chainId?: number
  limit?: number
  testnet?: boolean
}

export interface TokenListResponse {
  tokens: Token[]
  total: number
  page?: number
  limit?: number
  updatedAt: string
  metadata?: Record<string, any>
}

export interface QuoteRequest {
  fromChainId: number
  toChainId: number
  fromToken: string
  toToken: string
  amount: string
  userAddress?: string
  slippage?: number
}

export interface QuoteResponse {
  crossChain: boolean
  quotes: Quote[]
  quotesCount: number
  metadata: {
    aggregationTime: number
    performanceOptimized: boolean
    providers: string[]
    sortTime: number
    strategy: string
    totalTimeMs: number
  }
  request: {
    amount: string
    fromChainId: number
    fromToken: string
    slippage: string
    toChainId: number
    toToken: string
  }
  responseTime: number
  timestamp: number
}

export interface Quote {
  id: string
  provider: string
  fromAmount: string
  toAmount: string
  toAmountMin: string
  price: string
  priceImpact: string
  slippageTolerance: string
  callData: string
  to: string
  value: string
  fromToken: Token
  toToken: Token
  gasEstimate: GasEstimate
  route: Route
  createdAt: string
  expiresAt: string
  metadata?: Record<string, any>
}

export interface GasEstimate {
  gasLimit: number
  gasPrice: number
  gasFee: number
  gasFeeUSD: number
}

export interface Route {
  steps: RouteStep[]
  totalFee: number
  gasEstimate: GasEstimate
}

export interface RouteStep {
  type: string
  protocol: string
  fromToken: Token
  toToken: Token
  fromAmount: number
  toAmount: number
  fee: number
  priceImpact: number
  poolAddress: string
  gasEstimate: GasEstimate
}

export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  logoURI?: string;
  priceUSD?: number;
  change24h?: number;
  volume24h?: number;
  marketCap?: number;
  isNative?: boolean;
  verified?: boolean;
  popular?: boolean;
  tags?: string[];
  source?: string;
  lastUpdated?: string;
  metadata?: Record<string, any>;
}

class ApiClient {
  private authClient: AxiosInstance
  private aggregatorClient: AxiosInstance
  private coreClient: AxiosInstance
  private baseClient: AxiosInstance
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private isRefreshing: boolean = false
  private refreshPromise: Promise<void> | null = null

  constructor() {
    // Load tokens from localStorage on client
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken')
      this.refreshToken = localStorage.getItem('refreshToken')
    }

    // Create axios instances for different services
    this.baseClient = axios.create({
      baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000/api',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    this.authClient = axios.create({
      baseURL: process.env.NEXT_PUBLIC_AUTH_API_URL || 'http://localhost:3001/api/v1',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    this.aggregatorClient = axios.create({
      baseURL: process.env.NEXT_PUBLIC_AGGREGATOR_API_URL || 'http://localhost:3003/api/v1',
      timeout: 15000, // Longer timeout for aggregator
      headers: {
        'Content-Type': 'application/json',
      },
    })

    this.coreClient = axios.create({
      baseURL: process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3007/api/v1',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    // Setup interceptors
    this.setupInterceptors()
  }

  private setupInterceptors(): void {
    // Auth client interceptor - only add auth for endpoints that need it
    this.authClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      // Auth service endpoints that DON'T need authentication
      const publicEndpoints = ['/auth/login', '/health']
      const isPublicEndpoint = publicEndpoints.some(endpoint => config.url?.includes(endpoint))
      
      if (!isPublicEndpoint && this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`
      }
      return config
    })

    // Core client interceptor - ALL endpoints need authentication except health
    this.coreClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      const isHealthEndpoint = config.url?.includes('/health')
      
      if (!isHealthEndpoint && this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`
      } else if (!isHealthEndpoint && !this.accessToken) {
        console.warn('⚠️ Core API call without authentication:', config.url)
      }
      return config
    })

    // Response interceptors for automatic token refresh
    const setupResponseInterceptor = (client: AxiosInstance) => {
      client.interceptors.response.use(
        (response: AxiosResponse) => response,
        async (error: AxiosError) => {
          const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

          if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true

            try {
              await this.handleTokenRefresh()
              
              // Retry original request with new token
              if (this.accessToken) {
                originalRequest.headers.Authorization = `Bearer ${this.accessToken}`
                return client(originalRequest)
              }
            } catch (refreshError) {
              console.error('Token refresh failed:', refreshError)
              this.clearTokens()
              // Redirect to login or show auth modal
            }
          }

          return Promise.reject(error)
        }
      )
    }

    // Apply response interceptors to authenticated clients
    setupResponseInterceptor(this.authClient)
    setupResponseInterceptor(this.coreClient)
  }

  private async handleTokenRefresh(): Promise<void> {
    if (this.isRefreshing) {
      return this.refreshPromise || Promise.resolve()
    }

    this.isRefreshing = true
    this.refreshPromise = this.performTokenRefresh()

    try {
      await this.refreshPromise
    } finally {
      this.isRefreshing = false
      this.refreshPromise = null
    }
  }

  private async performTokenRefresh(): Promise<void> {
    try {
      if (!this.refreshToken) {
        throw new Error('No refresh token available')
      }

      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AUTH_API_URL || 'http://localhost:3001/api/v1'}/auth/refresh`,
        { refreshToken: this.refreshToken },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        }
      )

      if (response.data?.success && response.data?.data?.tokens) {
        const { accessToken, refreshToken } = response.data.data.tokens
        this.setTokens(accessToken, refreshToken)
        console.log('✅ Token refreshed successfully')
      } else {
        throw new Error('Invalid refresh response')
      }
    } catch (error) {
      console.error('❌ Token refresh failed:', error)
      this.clearTokens()
      throw error
    }
  }

  public setTokens(accessToken: string, refreshToken?: string): void {
    this.accessToken = accessToken
    if (refreshToken) {
      this.refreshToken = refreshToken
    }
    
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', accessToken)
      if (refreshToken) {
        localStorage.setItem('refreshToken', refreshToken)
      }
    }
  }

  public clearTokens(): void {
    this.accessToken = null
    this.refreshToken = null
    
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken')
      localStorage.removeItem('refreshToken')
    }
  }

  // ============ AUTH SERVICE METHODS ============

  public async login(privyToken: string): Promise<any> {
    try {
      const response = await this.authClient.post('/auth/login', { privyToken })
      
      if (response.data?.success && response.data?.data?.tokens) {
        const { accessToken, refreshToken } = response.data.data.tokens
        this.setTokens(accessToken, refreshToken)
        toast.success('Login successful!')
      } else {
        console.error('❌ API Client: Login failed - no tokens in response')
      }

      return response.data
    } catch (error: any) {
      console.error('❌ Login failed:', error.response?.data || error.message)
      throw error
    }
  }

  public async logout(): Promise<void> {
    try {
      await this.authClient.post('/auth/logout')
      toast.success('Logged out successfully')
    } catch (error) {
      console.error('Logout error:', error)
    } finally {
      this.clearTokens()
    }
  }

  public async getCurrentUser(): Promise<any> {
    // Ensure token is loaded from localStorage if not in memory
    if (!this.accessToken && typeof window !== 'undefined') {
      const storedToken = localStorage.getItem('accessToken')
      if (storedToken) {
        this.accessToken = storedToken
      }
    }
    
    if (!this.accessToken) {
      console.warn('⚠️ API Client: getCurrentUser called without access token')
      throw new Error('No access token available')
    }
    
    const response = await this.authClient.get('/auth/verify')
    return response.data
  }

  public async refreshTokens(): Promise<any> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available')
    }

    const response = await this.authClient.post('/auth/refresh', { 
      refreshToken: this.refreshToken 
    })
    
    if (response.data?.success && response.data?.data?.tokens) {
      const { accessToken, refreshToken } = response.data.data.tokens
      this.setTokens(accessToken, refreshToken)
    }
    
    return response.data
  }

  // ============ AGGREGATOR SERVICE METHODS ============
  // Note: Aggregator service doesn't require authentication based on README

  public async searchTokens(params: TokenSearchParams): Promise<TokenListResponse> {
    const searchParams = new URLSearchParams()
    searchParams.append('q', params.q)
    if (params.chainId) {
      searchParams.append('chainId', params.chainId.toString())
    }
    if (params.limit) {
      searchParams.append('limit', params.limit.toString())
    }
    if (params.testnet !== undefined) {
      searchParams.append('testnet', params.testnet.toString())
    }

    const response = await this.aggregatorClient.get(`/tokens/search?${searchParams}`)
    return response.data
  }

  public async getQuote(params: QuoteRequest): Promise<QuoteResponse> {
    const searchParams = new URLSearchParams()
    searchParams.append('fromChainId', params.fromChainId.toString())
    searchParams.append('toChainId', params.toChainId.toString())
    searchParams.append('fromToken', params.fromToken)
    searchParams.append('toToken', params.toToken)
    searchParams.append('amount', params.amount)
    if (params.userAddress) {
      searchParams.append('userAddress', params.userAddress)
    }
    if (params.slippage) {
      searchParams.append('slippage', params.slippage.toString())
    }

    const response = await this.aggregatorClient.get(`/quote?${searchParams}`)
    return response.data
  }

  public async getPopularTokens(params?: { chainId?: number; testnet?: boolean }): Promise<TokenListResponse> {
    const searchParams = new URLSearchParams()
    
    if (params?.chainId) {
      searchParams.append('chainId', params.chainId.toString())
    }
    
    if (params?.testnet !== undefined) {
      searchParams.append('testnet', params.testnet.toString())
    }
    
    const url = `/tokens/popular${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.aggregatorClient.get(url)
    
    return response.data
  }

  // ============ HEALTH CHECKS ============

  public async checkAuthHealth(): Promise<any> {
    const response = await this.authClient.get('/health')
    return response.data
  }

  public async checkAggregatorHealth(): Promise<any> {
    const response = await this.aggregatorClient.get('/health')
    return response.data
  }

  // ============ USER PROFILE METHODS ============

  public async getUserProfile(): Promise<any> {
    const response = await this.authClient.get('/user/profile')
    return response.data
  }

  public async updateUserProfile(profileData: any): Promise<any> {
    const response = await this.authClient.put('/user/profile', profileData)
    return response.data
  }

  public async getUserSessions(): Promise<any> {
    const response = await this.authClient.get('/session/list')
    return response.data
  }

  // ============ CORE SERVICE METHODS ============
  // Note: All Core service endpoints require authentication except health

  // Portfolio Management
  public async getPortfolio(params?: { 
    // Chain filters
    chainIds?: string; 
    
    // Position & Category filters  
    positionTypes?: string; // Comma-separated: SPOT,STAKED,LP,YIELD,BRIDGE,LOCKED
    categories?: string; // Comma-separated: DeFi,Gaming,NFT,Stablecoin
    
    // Security & Quality filters
    includeSpam?: boolean; // Default: false
    includeUnverified?: boolean; // Default: false
    minSecurityScore?: number; // 0-100
    maxRiskScore?: number; // 0-100
    
    // Value filters
    minValue?: number; // Minimum token value in USD
    maxValueUSD?: number; // Maximum token value in USD
    hideSmallBalances?: boolean; // Hide balances under $1
    
    // Sorting & Pagination
    sortBy?: 'value' | 'symbol' | 'balance' | 'positionType' | 'riskScore' | 'securityScore';
    sortOrder?: 'asc' | 'desc'; // Default: desc
    limit?: number; // Default: 500
    offset?: number; // Default: 0
  }): Promise<any> {
    const searchParams = new URLSearchParams()
    
    if (params?.chainIds) searchParams.append('chainIds', params.chainIds)
    if (params?.positionTypes) searchParams.append('positionTypes', params.positionTypes)
    if (params?.categories) searchParams.append('categories', params.categories)
    if (params?.includeSpam !== undefined) searchParams.append('includeSpam', params.includeSpam.toString())
    if (params?.includeUnverified !== undefined) searchParams.append('includeUnverified', params.includeUnverified.toString())
    if (params?.minSecurityScore !== undefined) searchParams.append('minSecurityScore', params.minSecurityScore.toString())
    if (params?.maxRiskScore !== undefined) searchParams.append('maxRiskScore', params.maxRiskScore.toString())
    if (params?.minValue !== undefined) searchParams.append('minValue', params.minValue.toString())
    if (params?.maxValueUSD !== undefined) searchParams.append('maxValueUSD', params.maxValueUSD.toString())
    if (params?.hideSmallBalances !== undefined) searchParams.append('hideSmallBalances', params.hideSmallBalances.toString())
    if (params?.sortBy) searchParams.append('sortBy', params.sortBy)
    if (params?.sortOrder) searchParams.append('sortOrder', params.sortOrder)
    if (params?.limit !== undefined) searchParams.append('limit', params.limit.toString())
    if (params?.offset !== undefined) searchParams.append('offset', params.offset.toString())
    
    const url = `/portfolio${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getTokenHoldings(params?: { 
    // Chain filters
    chainIds?: string; 
    
    // Position & Category filters  
    positionTypes?: string; // Comma-separated: SPOT,STAKED,LP,YIELD,BRIDGE,LOCKED
    categories?: string; // Comma-separated: DeFi,Gaming,NFT,Stablecoin
    
    // Security & Quality filters
    includeSpam?: boolean; // Default: false
    includeUnverified?: boolean; // Default: false
    minSecurityScore?: number; // 0-100
    maxRiskScore?: number; // 0-100
    
    // Value filters
    minValue?: number; // Minimum token value in USD
    maxValueUSD?: number; // Maximum token value in USD
    hideSmallBalances?: boolean; // Hide balances under $1
    
    // Sorting & Pagination
    sortBy?: 'value' | 'symbol' | 'balance' | 'positionType' | 'riskScore' | 'securityScore';
    sortOrder?: 'asc' | 'desc'; // Default: desc
    limit?: number; // Default: 500
    offset?: number; // Default: 0
  }): Promise<any> {
    const searchParams = new URLSearchParams()
    
    if (params?.chainIds) searchParams.append('chainIds', params.chainIds)
    if (params?.positionTypes) searchParams.append('positionTypes', params.positionTypes)
    if (params?.categories) searchParams.append('categories', params.categories)
    if (params?.includeSpam !== undefined) searchParams.append('includeSpam', params.includeSpam.toString())
    if (params?.includeUnverified !== undefined) searchParams.append('includeUnverified', params.includeUnverified.toString())
    if (params?.minSecurityScore !== undefined) searchParams.append('minSecurityScore', params.minSecurityScore.toString())
    if (params?.maxRiskScore !== undefined) searchParams.append('maxRiskScore', params.maxRiskScore.toString())
    if (params?.minValue !== undefined) searchParams.append('minValue', params.minValue.toString())
    if (params?.maxValueUSD !== undefined) searchParams.append('maxValueUSD', params.maxValueUSD.toString())
    if (params?.hideSmallBalances !== undefined) searchParams.append('hideSmallBalances', params.hideSmallBalances.toString())
    if (params?.sortBy) searchParams.append('sortBy', params.sortBy)
    if (params?.sortOrder) searchParams.append('sortOrder', params.sortOrder)
    if (params?.limit !== undefined) searchParams.append('limit', params.limit.toString())
    if (params?.offset !== undefined) searchParams.append('offset', params.offset.toString())
    
    const url = `/portfolio/holdings${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getQuickPortfolio(): Promise<any> {
    const response = await this.coreClient.get('/portfolio/quick')
    return response.data
  }

  public async refreshPortfolio(): Promise<any> {
    const response = await this.coreClient.post('/portfolio/refresh')
    return response.data
  }

  // Sync Management
  public async getSyncStatus(): Promise<any> {
    const response = await this.coreClient.get('/sync/status')
    return response.data
  }

  public async triggerSync(options: { 
    syncType?: 'portfolio' | 'trades' | 'full'
    priority?: 'high' | 'medium' | 'low'
    source?: string
  } = {}): Promise<any> {
    const response = await this.coreClient.post('/sync/trigger', options)
    return response.data
  }

  public async getSyncOperations(filters?: {
    limit?: number
    status?: string
    type?: string
    days?: number
  }): Promise<any> {
    const response = await this.coreClient.get('/sync/operations', { params: filters })
    return response.data
  }

  // P&L Analytics
  public async getPortfolioPnL(params?: { timeframe?: string; walletAddress?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.timeframe) searchParams.append('timeframe', params.timeframe)
    if (params?.walletAddress) searchParams.append('walletAddress', params.walletAddress)
    
    const url = `/portfolio/pnl${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getPortfolioAnalytics(params?: { timeframe?: string; breakdown?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.timeframe) searchParams.append('timeframe', params.timeframe)
    if (params?.breakdown) searchParams.append('breakdown', params.breakdown)
    
    const url = `/portfolio/analytics${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getPortfolioHistory(params?: { timeframe?: string; interval?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.timeframe) searchParams.append('timeframe', params.timeframe)
    if (params?.interval) searchParams.append('interval', params.interval)
    
    const url = `/portfolio/history${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  // Trading History
  public async getRecentTrades(params?: { limit?: number; days?: number; chainIds?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.limit) searchParams.append('limit', params.limit.toString())
    if (params?.days) searchParams.append('days', params.days.toString())
    if (params?.chainIds) searchParams.append('chainIds', params.chainIds)
    
    const url = `/portfolio/trades${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async recordTrade(tradeData: {
    txHash: string
    chainId: number
    blockNumber?: number
    timestamp?: string
    type?: 'swap' | 'buy' | 'sell'
    status?: 'pending' | 'completed' | 'failed'
    fromToken: {
      address: string
      symbol: string
      name: string
      decimals: number
      amount: string
      amountFormatted: number
      priceUSD: number
      valueUSD: number
    }
    toToken: {
      address: string
      symbol: string
      name: string
      decimals: number
      amount: string
      amountFormatted: number
      priceUSD: number
      valueUSD: number
    }
    gasFeeETH?: number
    gasFeeUSD: number
    protocolFeeUSD?: number
    slippage?: number
    priceImpact?: number
    dexName?: string
    routerAddress?: string
    aggregator?: 'lifi' | '1inch' | 'relay' | 'jupiter'
  }): Promise<any> {

    const response = await this.coreClient.post('/portfolio/trades', tradeData)
    return response.data
  }

  // Order Management
  public async createOrder(orderData: any): Promise<any> {
    const response = await this.coreClient.post('/orders', orderData)
    return response.data
  }

  public async getOrders(params?: { limit?: number; offset?: number; status?: string; type?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.limit) searchParams.append('limit', params.limit.toString())
    if (params?.offset) searchParams.append('offset', params.offset.toString())
    if (params?.status) searchParams.append('status', params.status)
    if (params?.type) searchParams.append('type', params.type)
    
    const url = `/orders${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getActiveOrders(): Promise<any> {
    const response = await this.coreClient.get('/orders/active')
    return response.data
  }

  public async getOrderById(orderId: string): Promise<any> {
    const response = await this.coreClient.get(`/orders/${orderId}`)
    return response.data
  }

  public async updateOrder(orderId: string, updateData: any): Promise<any> {
    const response = await this.coreClient.put(`/orders/${orderId}`, updateData)
    return response.data
  }

  public async cancelOrder(orderId: string): Promise<any> {
    const response = await this.coreClient.delete(`/orders/${orderId}`)
    return response.data
  }

  public async recordOrderExecution(orderId: string, executionData: any): Promise<any> {
    const response = await this.coreClient.post(`/orders/${orderId}/executions`, executionData)
    return response.data
  }

  public async getOrderStats(): Promise<any> {
    const response = await this.coreClient.get('/orders/stats')
    return response.data
  }

  // Bitquery API
  public async getBitqueryData(endpoint: string, params: Record<string, any> = {}): Promise<any> {
    const searchParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, value.toString())
      }
    })
    
    const url = `/bitquery/${endpoint}${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  // Health Check
  public async checkCoreHealth(): Promise<any> {
    const response = await this.coreClient.get('/health')
    return response.data
  }

  // ============ STATS SERVICE METHODS ============
  // Stats API endpoints for chain performance and bridge status

  public async getChainStats(params?: { limit?: number; chainIds?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.limit) searchParams.append('limit', params.limit.toString())
    if (params?.chainIds) searchParams.append('chainIds', params.chainIds)
    
    const url = `/stats/chain${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getBridgeStats(params?: { limit?: number; bridgeIds?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.limit) searchParams.append('limit', params.limit.toString())
    if (params?.bridgeIds) searchParams.append('bridgeIds', params.bridgeIds)
    
    const url = `/stats/bridge${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getAllStats(params?: { limit?: number }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.limit) searchParams.append('limit', params.limit.toString())
    
    const url = `/stats/all${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getStatsOverview(): Promise<any> {
    const response = await this.coreClient.get('/stats/overview')
    return response.data
  }

  public async getActiveAlerts(params?: { limit?: number; severity?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.limit) searchParams.append('limit', params.limit.toString())
    if (params?.severity) searchParams.append('severity', params.severity)
    
    const url = `/stats/alerts${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getAggregatedStats(params?: { timeframe?: string; interval?: string }): Promise<any> {
    const searchParams = new URLSearchParams()
    if (params?.timeframe) searchParams.append('timeframe', params.timeframe)
    if (params?.interval) searchParams.append('interval', params.interval)
    
    const url = `/stats/aggregated${searchParams.toString() ? '?' + searchParams.toString() : ''}`
    const response = await this.coreClient.get(url)
    return response.data
  }

  public async getStatsHealth(): Promise<any> {
    const response = await this.coreClient.get('/stats/health')
    return response.data
  }
}

// Singleton instance
export const apiClient = new ApiClient()

// Helper functions for easier usage
export const authApi = {
  login: (privyToken: string) => apiClient.login(privyToken),
  logout: () => apiClient.logout(),
  getCurrentUser: () => apiClient.getCurrentUser(),
  getUserProfile: () => apiClient.getUserProfile(),
  updateProfile: (data: any) => apiClient.updateUserProfile(data),
  getSessions: () => apiClient.getUserSessions(),
  checkAuthHealth: () => apiClient.checkAuthHealth(),
}

export const aggregatorApi = {
  searchTokens: (params: TokenSearchParams) => apiClient.searchTokens(params),
  getQuote: (params: QuoteRequest) => apiClient.getQuote(params),
  getPopularTokens: (params?: { chainId?: number; testnet?: boolean }) => apiClient.getPopularTokens(params),
  checkAggregatorHealth: () => apiClient.checkAggregatorHealth(),
}

export const coreApi = {
  // Portfolio Management
  getPortfolio: (params?: { 
    // Chain filters
    chainIds?: string; 
    
    // Position & Category filters  
    positionTypes?: string; // Comma-separated: SPOT,STAKED,LP,YIELD,BRIDGE,LOCKED
    categories?: string; // Comma-separated: DeFi,Gaming,NFT,Stablecoin
    
    // Security & Quality filters
    includeSpam?: boolean; // Default: false
    includeUnverified?: boolean; // Default: false
    minSecurityScore?: number; // 0-100
    maxRiskScore?: number; // 0-100
    
    // Value filters
    minValue?: number; // Minimum token value in USD
    maxValueUSD?: number; // Maximum token value in USD
    hideSmallBalances?: boolean; // Hide balances under $1
    
    // Sorting & Pagination
    sortBy?: 'value' | 'symbol' | 'balance' | 'positionType' | 'riskScore' | 'securityScore';
    sortOrder?: 'asc' | 'desc'; // Default: desc
    limit?: number; // Default: 500
    offset?: number; // Default: 0
  }) => 
    apiClient.getPortfolio(params),
  getTokenHoldings: (params?: { 
    // Chain filters
    chainIds?: string; 
    
    // Position & Category filters  
    positionTypes?: string; // Comma-separated: SPOT,STAKED,LP,YIELD,BRIDGE,LOCKED
    categories?: string; // Comma-separated: DeFi,Gaming,NFT,Stablecoin
    
    // Security & Quality filters
    includeSpam?: boolean; // Default: false
    includeUnverified?: boolean; // Default: false
    minSecurityScore?: number; // 0-100
    maxRiskScore?: number; // 0-100
    
    // Value filters
    minValue?: number; // Minimum token value in USD
    maxValueUSD?: number; // Maximum token value in USD
    hideSmallBalances?: boolean; // Hide balances under $1
    
    // Sorting & Pagination
    sortBy?: 'value' | 'symbol' | 'balance' | 'positionType' | 'riskScore' | 'securityScore';
    sortOrder?: 'asc' | 'desc'; // Default: desc
    limit?: number; // Default: 500
    offset?: number; // Default: 0
  }) => 
    apiClient.getTokenHoldings(params),
  getQuickPortfolio: () => apiClient.getQuickPortfolio(),
  refreshPortfolio: () => apiClient.refreshPortfolio(),
  
  // Sync Management (delegated to sync worker)
  getSyncStatus: () => apiClient.getSyncStatus(),
  triggerSync: (options?: { syncType?: 'portfolio' | 'trades' | 'full'; priority?: 'high' | 'medium' | 'low'; source?: string }) => 
    apiClient.triggerSync(options),
  getSyncOperations: (filters?: { limit?: number; status?: string; type?: string; days?: number }) => 
    apiClient.getSyncOperations(filters),
  
  // P&L Analytics
  getPortfolioPnL: (params?: { timeframe?: string; walletAddress?: string }) => 
    apiClient.getPortfolioPnL(params),
  getPortfolioAnalytics: (params?: { timeframe?: string; breakdown?: string }) => 
    apiClient.getPortfolioAnalytics(params),
  getPortfolioHistory: (params?: { timeframe?: string; interval?: string }) => 
    apiClient.getPortfolioHistory(params),
    
  // Trading History
  getRecentTrades: (params?: { limit?: number; days?: number; chainIds?: string }) => 
    apiClient.getRecentTrades(params),
  recordTrade: (tradeData: any) => apiClient.recordTrade(tradeData),
    
  // Order Management
  createOrder: (orderData: any) => apiClient.createOrder(orderData),
  getOrders: (params?: { limit?: number; offset?: number; status?: string; type?: string }) => 
    apiClient.getOrders(params),
  getActiveOrders: () => apiClient.getActiveOrders(),
  getOrderById: (orderId: string) => apiClient.getOrderById(orderId),
  updateOrder: (orderId: string, updateData: any) => apiClient.updateOrder(orderId, updateData),
  cancelOrder: (orderId: string) => apiClient.cancelOrder(orderId),
  recordOrderExecution: (orderId: string, executionData: any) => 
    apiClient.recordOrderExecution(orderId, executionData),
  getOrderStats: () => apiClient.getOrderStats(),
  
  // Bitquery API
  getBitqueryData: (endpoint: string, params: Record<string, any> = {}) => 
    apiClient.getBitqueryData(endpoint, params),
  
  // Health Check
  checkHealth: () => apiClient.checkCoreHealth(),
  
  // Stats API
  getChainStats: (params?: { limit?: number; chainIds?: string }) => 
    apiClient.getChainStats(params),
  getBridgeStats: (params?: { limit?: number; bridgeIds?: string }) => 
    apiClient.getBridgeStats(params),
  getAllStats: (params?: { limit?: number }) => 
    apiClient.getAllStats(params),
  getStatsOverview: () => apiClient.getStatsOverview(),
  getActiveAlerts: (params?: { limit?: number; severity?: string }) => 
    apiClient.getActiveAlerts(params),
  getAggregatedStats: (params?: { timeframe?: string; interval?: string }) => 
    apiClient.getAggregatedStats(params),
  getStatsHealth: () => apiClient.getStatsHealth(),
}

export default apiClient 