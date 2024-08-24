import { ENV } from '../../config/env';
import { loadChatLLM } from '../../agent';
import type { StreamResultHandler } from '../../agent/chat';
import { requestCompletionsFromLLM } from '../../agent/chat';
import type { HistoryModifier, LLMChatRequestParams } from '../../agent/types';
import type { WorkerContext } from '../../config/context';
import { MessageSender } from '../utils/send';
import type { Telegram } from '../../types/telegram';
import { uploadImageToTelegraph } from '../../utils/image';
import { createTelegramBotAPI } from '../api';
import type { MessageHandler } from './type';

export async function chatWithLLM(message: Telegram.Message, params: LLMChatRequestParams, context: WorkerContext, modifier: HistoryModifier | null): Promise<Response> {
    const sender = MessageSender.from(context.SHARE_CONTEXT.botToken, message);
    try {
        try {
            const msg = await sender.sendPlainText('...').then(r => r.json()) as Telegram.ResponseSuccess<Telegram.Message>;
            sender.update({
                message_id: msg.result.message_id,
            });
        } catch (e) {
            console.error(e);
        }
        const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
        setTimeout(() => api.sendChatAction({
            chat_id: message.chat.id,
            action: 'typing',
        }).catch(console.error), 0);
        let onStream: StreamResultHandler | null = null;
        let nextEnableTime: number | null = null;
        if (ENV.STREAM_MODE) {
            onStream = async (text: string): Promise<any> => {
                try {
                    // 判断是否需要等待
                    if (nextEnableTime && nextEnableTime > Date.now()) {
                        return;
                    }
                    const resp = await sender.sendPlainText(text);
                    // 判断429
                    if (resp.status === 429) {
                        // 获取重试时间
                        const retryAfter = Number.parseInt(resp.headers.get('Retry-After') || '');
                        if (retryAfter) {
                            nextEnableTime = Date.now() + retryAfter * 1000;
                            return;
                        }
                    }
                    nextEnableTime = null;
                    if (resp.ok) {
                        const respJson = await resp.json() as Telegram.ResponseSuccess<Telegram.Message>;
                        sender.update({
                            message_id: respJson.result.message_id,
                        });
                    }
                } catch (e) {
                    console.error(e);
                }
            };
        }

        const agent = loadChatLLM(context.USER_CONFIG);
        if (agent === null) {
            return sender.sendPlainText('LLM is not enable');
        }
        const answer = await requestCompletionsFromLLM(params, context, agent, modifier, onStream);
        if (nextEnableTime !== null && nextEnableTime > Date.now()) {
            await new Promise(resolve => setTimeout(resolve, (nextEnableTime ?? 0) - Date.now()));
        }
        return sender.sendRichText(answer);
    } catch (e) {
        let errMsg = `Error: ${(e as Error).message}`;
        if (errMsg.length > 2048) {
            // 裁剪错误信息 最长2048
            errMsg = errMsg.substring(0, 2048);
        }
        return sender.sendPlainText(errMsg);
    }
}

function findPhotoFileID(photos: Telegram.PhotoSize[], offset: number): string {
    let sizeIndex = 0;
    if (offset >= 0) {
        sizeIndex = offset;
    } else if (offset < 0) {
        sizeIndex = photos.length + offset;
    }
    sizeIndex = Math.max(0, Math.min(sizeIndex, photos.length - 1));
    return photos[sizeIndex].file_id;
}

export class ChatHandler implements MessageHandler {
    handle = async (message: Telegram.Message, context: WorkerContext): Promise<Response | null> => {
        const params: LLMChatRequestParams = {
            message: message.text || message.caption || '',
        };

        if (message.photo && message.photo.length > 0) {
            const id = findPhotoFileID(message.photo, ENV.TELEGRAM_PHOTO_SIZE_OFFSET);
            const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
            const file = await api.getFile({ file_id: id }).then(res => res.json()) as Telegram.ResponseSuccess<Telegram.File>;
            let url = file.result.file_path;
            if (url) {
                if (ENV.TELEGRAPH_ENABLE) {
                    url = await uploadImageToTelegraph(url);
                }
                params.images = [url];
            }
        }
        return chatWithLLM(message, params, context, null);
    };
}
