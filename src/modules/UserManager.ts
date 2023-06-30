import Bottleneck from 'bottleneck'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'stream'
import winston from 'winston'
import { twitterApiLimiter } from '../Limiter'
import { api } from '../api/twitter.api'
import { TwitterApi } from '../apis/TwitterApi'
import { TWITTER_API_LIST_SIZE, TWITTER_USER_FETCH_INTERVAL } from '../constants/twitter.constant'
import { logger as baseLogger } from '../logger'
import { Util } from '../utils/Util'
import { configManager } from './ConfigManager'

export interface User {
  id: string
  username: string
}

class UserManager extends EventEmitter {
  private logger: winston.Logger
  private users: User[] = []

  constructor() {
    super()
    this.logger = baseLogger.child({ label: '[UserManager]' })
  }

  public getUsers() {
    return this.users
  }

  public getUserById(id: string) {
    return this.users.find((v) => v.id === id)
  }

  public getUserByUsername(username: string) {
    return this.users.find((v) => v.username.toLowerCase() === username.toLowerCase())
  }

  public getUsersWithId() {
    return this.users.filter((v) => v.id)
  }

  public getUsersWithoutId() {
    return this.users.filter((v) => !v.id)
  }

  public async add(usernames: string[]) {
    this.logger.debug('add', { usernames })
    usernames.forEach((username) => {
      if (this.getUserByUsername(username)) {
        return
      }
      this.users.push({ id: null, username })
    })
    await this.fetchUsers()
  }

  private updateUser(user: User) {
    if (!user) {
      return
    }
    const tmpUser = this.getUserByUsername(user.username)
    if (!tmpUser) {
      return
    }
    Object.assign(tmpUser, user)
  }

  private async fetchUsers() {
    try {
      if (Util.getTwitterAuthorization()) {
        await this.fetchUsersByLookup()
      } else {
        await this.fetchUsersByScreenName()
      }
    } catch (error) {
      this.logger.error(`fetchUsers: ${error.message}`)
    }
    const users = this.getUsersWithoutId()
    if (users.length) {
      this.logger.warn(`fetchUsers: Found some users without id. Retry in ${TWITTER_USER_FETCH_INTERVAL}ms`, { usernames: users.map((v) => v.username) })
      setTimeout(() => this.fetchUsers(), TWITTER_USER_FETCH_INTERVAL)
    }
  }

  private async fetchUsersByLookup() {
    this.logger.debug('--> fetchUsersByLookup')
    const chunks = Util.splitArrayIntoChunk(
      this.getUsersWithoutId().map((v) => v.username),
      TWITTER_API_LIST_SIZE,
    )
    const responses = await Promise.allSettled(
      chunks.map((usernames, i) => twitterApiLimiter.schedule(async () => {
        const requestId = randomUUID()
        try {
          this.logger.debug(`--> getUsersByUsernames ${i + 1}`, { requestId, usernames })
          const { data: users } = await TwitterApi.getUsersByUsernames(
            usernames,
            { authorization: Util.getTwitterAuthorization() },
          )
          this.logger.debug(`<-- getUsersByUsernames ${i + 1}`, { requestId })
          return Promise.resolve(users)
        } catch (error) {
          this.logger.error(`getUsersByUsernames: ${error.message}`, { requestId, response: { data: error.response?.data } })
          throw error
        }
      })),
    )
    responses.forEach((response) => {
      if (response.status !== 'fulfilled' || !response.value) {
        return
      }
      response.value.forEach((v) => {
        this.updateUser({
          id: v.id,
          username: v.username,
        })
      })
    })
    this.logger.debug('<-- fetchUsersByLookup')
  }

  private async fetchUsersByScreenName() {
    this.logger.debug('--> fetchUsersByScreenName')
    const limiter = new Bottleneck({ maxConcurrent: 1 })
    const users = this.getUsersWithoutId()
    await Promise.allSettled(users.map((curUser, index) => limiter.schedule(async () => {
      const { username } = curUser
      this.logger.debug(`--> getUserByScreenName ${index + 1}`, { username })
      const user = await this.getUserByScreenName(username)
      this.logger.debug(`<-- getUserByScreenName ${index + 1}`, { username })
      this.updateUser(user)
      return Promise.resolve(user)
    })))
    this.logger.debug('<-- fetchUsersByScreenName')
  }

  private async getUserByScreenName(username: string): Promise<User> {
    try {
      await configManager.getGuestToken()
      const { data } = await api.graphql.UserByScreenName(username)
      const result = data?.data?.user?.result
      if (!result) {
        return null
      }
      const user = {
        id: result.rest_id,
        username: result.legacy.screen_name,
      }
      return user
    } catch (error) {
      this.logger.error(`getUserByScreenName: ${error.message}`, { username })
    }

    return null
  }
}

export const userManager = new UserManager()
