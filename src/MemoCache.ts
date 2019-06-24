import * as Redis from 'ioredis';
import * as uuidv4 from 'uuid/v4'

var redis = new Redis({dropBufferSupport: true});
var pub = new Redis();


class RedisMemoLock {

    private renewLockLuaScript = `
    if redis.call('GET', KEYS[1]) == ARGV[1]
    then 
        redis.call('EXPIRE', KEYS[1], ARGV[2]) 
        return 1
    else 
        return 0
    end
`;

    // NewRedisMemoLock Creates a new RedisMemoLock instance
    public static async newRedisMemoLock(subClient: Redis.Redis, allClient: Redis.Redis, resourceTag: string, lockTimeout: number): Promise<RedisMemoLock> {

        const pattern = resourceTag + "/notif:*";

        //subscribe to the pattern , all caches will publish to this pattern
        await subClient.psubscribe(pattern, <any>((err: any, count: number) => {
            if (err) throw err;
        }));

        const subscriptions = new Map();
        subClient.on('pmessage', function (pattern, channel, message) {

            const callbackList = subscriptions.get(channel);
            if (callbackList) {
                callbackList.forEach((callback: SubListenerFunction) => callback(null, channel, message));
                subscriptions.delete(channel);
            }
        });

        const result: RedisMemoLock = new RedisMemoLock(
            subClient,
            allClient,
            resourceTag,
            lockTimeout,
            subscriptions);

        return result;
    }

    private constructor(public subClient: Redis.Redis,
                        public allClient: Redis.Redis,
                        public resourceTag: string,
                        public lockTimeout: number,
                        public subscriptions: Map<string, Array<SubListenerFunction>>) {
    }


    private addSubscription(key: string, value: SubListenerFunction) {
        let existing = this.subscriptions.get(key);
        if (!existing) {
            existing = [];
            this.subscriptions.set(key, existing);
        }
        existing.push(value);
    }

    // Returns a function that will try to extend the resource lock upon execution
    private lockRenewFuncGenerator(lockKey: string, reqUUID: string): LockRenewFunc {
        return async (extension: number) => {
            let cmd = await this.allClient.eval(this.renewLockLuaScript, 1, lockKey, reqUUID, extension);

            // Were we still owning the lock when we tried to extend it?
            if (cmd != 1) {
                throw new Error('Unable to renew the lock');
            }
        }
    }

    // GetResourceRenewable has the same purpose as GetResource but allows the caller to extend the lock lease during the execution of generatingFunc
    public getResourceRenewable(resID: string, timeout: number, generatingFunc: RenewableFetchFunc) {
        const reqUUID = uuidv4();
        const lockID = this.resourceTag + "/lock:" + resID;

        // We now prepare a wrapper that injects a lock-extending function
        // as a parameter to the one provided by the caller.
        const injectedFunc = (): Promise<FetchFuncResult> => {
            return generatingFunc(this.lockRenewFuncGenerator(lockID, reqUUID));
        }

        return this.getResourceImpl(resID, injectedFunc, timeout, reqUUID)
    }

    // GetResource tries to get a resource from Redis, resorting to call generatingFunc in case of a cache miss
    public getResource(resID: string, timeout: number, generatingFunc: FetchFunc) {
        const reqUUID = uuidv4();
        return this.getResourceImpl(resID, generatingFunc, timeout, reqUUID)
    }

    private async getResourceImpl(resourceId: string, generatingFunc: FetchFunc, timeout: number, reqUUID: string):Promise<string> {
        const resourceKey = this.resourceTag + ":" + resourceId;
        const lockKey = this.resourceTag + "/lock:" + resourceId;
        const notifKey = this.resourceTag + "/notif:" + resourceId;

        //lets try to get the value from the cache
        let cacheValue = await this.allClient.get(resourceKey);
        if (cacheValue) {
            return cacheValue;
        }

        //the value was not in the cache so lets try to get the resource lock
        const resourceLock = await this.allClient.set(lockKey, reqUUID, 'EX', this.lockTimeout, 'NX');
        if (resourceLock) {
            let fetchedResult;
            try {
                fetchedResult = await generatingFunc();
            } catch (err) {
                // since the generating function failed, lets release the lock early
                await this.allClient.del(lockKey);
                throw err;
            }

            //helper variable and callback for retrieving any errors from the pipeline execution
            //todo if more than one error happens, only one will be saved to pipelineError
            let pipelineError;
            const pipelineCallback = (err: any, results: any) => {
                if (err) pipelineError = err;
            };

            const pipeline = this.allClient.pipeline();
            pipeline.set(resourceKey, fetchedResult.value, 'EX', fetchedResult.timeToLive, pipelineCallback);
            pipeline.publish(notifKey, fetchedResult.value, pipelineCallback);

            await pipeline.exec(pipelineCallback);
            if (pipelineError) {
                throw pipelineError;
            }

            return fetchedResult.value;
        }

        //create a promise and save the resolve and reject methods into variables so we can use them outside the promise
        let promiseResolve: Function, promiseReject: Function;
        const promise = new Promise<string>(function (resolve, reject) {
            promiseResolve = resolve;
            promiseReject = reject;

            //if promiseResolve is not called in time then it rejects
            setTimeout(function () {
                reject(new Error('Timeout listening for subscription for ' + notifKey));
            }, timeout * 1000)
        });


        const subscriptionCallback: SubListenerFunction = (err: any, channel: string, message: string) => {
            if (promiseResolve) {
                promiseResolve(message);
            } else {
                //rare race condition where the subscriptionCallback is called before the promise is initialized,
                //this can only happen right after the resourceKey was set, so we can just return it
                this.allClient.get(resourceKey).then(cacheVal => {
                    if (cacheVal) {
                        promiseResolve(cacheVal);
                    } else {
                        //should never end up here
                        throw new Error('subscriptionCallback error, promiseResolve was not set and cache value was null');
                    }
                });
            }
        };

        //add our callback as a listener for this notifKey
        this.addSubscription(notifKey, subscriptionCallback);

        // Refetch the key in case we missed the pubsub announcement by a hair.
        cacheValue = await this.allClient.get(resourceKey);
        if (cacheValue) {
            return cacheValue;
        }
        return await promise;
    }
}

// SubListenerFunction is the function received by the channel subscription listeners
interface SubListenerFunction {
    (err: any, channel: string, message: string): void
}

// FetchFunc is the function that the caller should provide to compute the value if not present in Redis already.
interface FetchFunc {
    (): Promise<FetchFuncResult>;
}

// LockRenewFunc is the function that RenewableFetchFunc will get as input and that must be called to extend a locks' life
interface LockRenewFunc {
    (extension: number): Promise<any>;
}

// RenewableFetchFunc has the same purpose as FetchFunc but, when called, it is offered a function that allows to extend the lock,
// for scenarios where the Fetch Function might take longer than the lock duration to execute
interface RenewableFetchFunc {
    (func: LockRenewFunc): Promise<FetchFuncResult>;
}

// timeToLive defines for how long the value should be cached in Redis.
interface FetchFuncResult {
    value: string,
    timeToLive: number
}
