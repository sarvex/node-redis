import * as LinkedList from 'yallist';
import { AbortError, ErrorReply } from '../errors';
import { RedisCommandArgument, RedisCommandArguments, RedisCommandRawReply } from '../commands';
import RESP2Decoder from './RESP2/decoder';
import encodeCommand from './RESP2/encoder';
import { PubSub, PubSubCommand, PubSubListener, PubSubTypes } from './pub-sub';

export interface QueueCommandOptions {
    asap?: boolean;
    chainId?: symbol;
    signal?: AbortSignal;
    returnBuffers?: boolean;
    ignorePubSubMode?: boolean;
}

export interface CommandWaitingToBeSent extends CommandWaitingForReply {
    args: RedisCommandArguments;
    chainId?: symbol;
    abort?: {
        signal: AbortSignal;
        listener(): void;
    };
}

interface CommandWaitingForReply {
    resolve(reply?: unknown): void;
    reject(err: unknown): void;
    channelsCounter?: number;
    returnBuffers?: boolean;
}

export default class RedisCommandsQueue {
    static #flushQueue<T extends CommandWaitingForReply>(queue: LinkedList<T>, err: Error): void {
        while (queue.length) {
            queue.shift()!.reject(err);
        }
    }

    readonly #maxLength: number | null | undefined;
    readonly #waitingToBeSent = new LinkedList<CommandWaitingToBeSent>();
    readonly #waitingForReply = new LinkedList<CommandWaitingForReply>();

    readonly #pubSub = new PubSub();

    #chainInExecution: symbol | undefined;

    #decoder = new RESP2Decoder({
        returnStringsAsBuffers: () => {
            return !!this.#waitingForReply.head?.value.returnBuffers ||
                this.#pubSub.isActive;
        },
        onReply: reply => {
            if (this.#pubSub.isActive && Array.isArray(reply)) {
                if (
                    !this.#pubSub.handleMessageReply(reply as Array<Buffer>) &&
                    this.#pubSub.handleStatusReply(reply as Array<Buffer>)
                ) {
                    if (--this.#waitingForReply.head!.value.channelsCounter! === 0) {
                        this.#waitingForReply.shift()!.resolve();
                    }
                }
                
                return;
            } else if (!this.#waitingForReply.length) {
                throw new Error('Got an unexpected reply from Redis');
            }

            const { resolve, reject } = this.#waitingForReply.shift()!;
            if (reply instanceof ErrorReply) {
                reject(reply);
            } else {
                resolve(reply);
            }
        }
    });

    constructor(maxLength: number | null | undefined) {
        this.#maxLength = maxLength;
    }

    addCommand<T = RedisCommandRawReply>(args: RedisCommandArguments, options?: QueueCommandOptions): Promise<T> {
        if (this.#pubSub.isActive && !options?.ignorePubSubMode) {
            return Promise.reject(new Error('Cannot send commands in PubSub mode'));
        } else if (this.#maxLength && this.#waitingToBeSent.length + this.#waitingForReply.length >= this.#maxLength) {
            return Promise.reject(new Error('The queue is full'));
        } else if (options?.signal?.aborted) {
            return Promise.reject(new AbortError());
        }

        return new Promise((resolve, reject) => {
            const node = new LinkedList.Node<CommandWaitingToBeSent>({
                args,
                chainId: options?.chainId,
                returnBuffers: options?.returnBuffers,
                resolve,
                reject
            });

            if (options?.signal) {
                const listener = () => {
                    this.#waitingToBeSent.removeNode(node);
                    node.value.reject(new AbortError());
                };
                node.value.abort = {
                    signal: options.signal,
                    listener
                };
                // AbortSignal type is incorrent
                (options.signal as any).addEventListener('abort', listener, {
                    once: true
                });
            }

            if (options?.asap) {
                this.#waitingToBeSent.unshiftNode(node);
            } else {
                this.#waitingToBeSent.pushNode(node);
            }
        });
    }

    subscribe<T extends boolean>(
        type: PubSubTypes,
        channels: string | Array<string>,
        listener: PubSubListener<T>,
        returnBuffers?: T
    ): Promise<void> {
        return this.#pushPubSubCommand(
            this.#pubSub.subscribe(type, channels, listener, returnBuffers)
        );
    }

    unsubscribe<T extends boolean>(
        type: PubSubTypes,
        channels?: string | Array<string>,
        listener?: PubSubListener<T>,
        returnBuffers?: T
    ): Promise<void> {
        return this.#pushPubSubCommand(
            this.#pubSub.unsubscribe(type, channels, listener, returnBuffers)
        );
    }

    #pushPubSubCommand(command: PubSubCommand | undefined): Promise<void> {
        if (!command) return Promise.resolve();

        return new Promise((resolve, reject) => {
            this.#waitingToBeSent.push({
                args: command.args,
                channelsCounter: command.channelsCounter,
                returnBuffers: true,
                resolve: () => {
                    command.fulfilled();
                    command.resolve?.();
                    resolve();
                },
                reject: err => {
                    command.fulfilled();
                    command.reject?.();
                    reject(err);
                }
            });
        });
    }

    resubscribe(): Promise<any> | undefined {
        return Promise.all(
            this.#pubSub.resubscribe()
                .map(command => this.#pushPubSubCommand(command))
        );
    }

    getCommandToSend(): RedisCommandArguments | undefined {
        const toSend = this.#waitingToBeSent.shift();
        if (!toSend) return;

        let encoded: RedisCommandArguments;
        try {
            encoded = encodeCommand(toSend.args);
        } catch (err) {
            toSend.reject(err);
            return;
        }

        this.#waitingForReply.push({
            resolve: toSend.resolve,
            reject: toSend.reject,
            channelsCounter: toSend.channelsCounter,
            returnBuffers: toSend.returnBuffers
        });
        this.#chainInExecution = toSend.chainId;
        return encoded;
    }

    onReplyChunk(chunk: Buffer): void {
        this.#decoder.write(chunk);
    }

    flushWaitingForReply(err: Error): void {
        this.#decoder.reset();
        this.#pubSub.isActive = false;
        RedisCommandsQueue.#flushQueue(this.#waitingForReply, err);

        if (!this.#chainInExecution) return;

        while (this.#waitingToBeSent.head?.value.chainId === this.#chainInExecution) {
            this.#waitingToBeSent.shift();
        }

        this.#chainInExecution = undefined;
    }

    flushAll(err: Error): void {
        RedisCommandsQueue.#flushQueue(this.#waitingForReply, err);
        RedisCommandsQueue.#flushQueue(this.#waitingToBeSent, err);
    }
}
