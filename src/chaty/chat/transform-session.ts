import { Message } from "wechaty";
import * as BotManager from "../bot/bot-manager"
import RawChatHistoryMessage from "./messages/raw-history-message";
import { MessageType } from "wechaty-puppet";
import ChatMessage from "./messages/chat-message";
import { TextChatMessageContent } from "./messages/message-content";
import * as ChatStore from './chat-store';
import * as xmlParser from 'fast-xml-parser';
import { ImageMessageConverter } from './converting/converters/image-message-converter';
import { UrlMessageConverter } from './converting/converters/url-message-converter';
import { TextMessageConverter, TextMessage } from "./converting/converters/text-message-converter";
import IntermediateMessage from "./converting/intermediate-message";


const notice = {
    started: '消息已收到 [Grin]',
    completed: '转换完成 [Smart]',
    notInChat: '你不是对话的参与者，请不要转发他人的对话 [Angry]'
}


interface ConvertState {
    hasMissingItems: boolean,
    missingItems: any
}

var allConverters = [
    new ImageMessageConverter(),
    new UrlMessageConverter(),
    new TextMessageConverter()
];


function parseXMLToMsgCollection(msgText) : any {
    const xmlOptions = {attrNodeName: '@', attributeNamePrefix: '', ignoreAttributes : false };
    const msgObj = xmlParser.parse(msgText, xmlOptions);
   
    const recordListXmlText = msgObj.msg.appmsg.recorditem;
    return xmlParser.parse(recordListXmlText, xmlOptions);
}



export default class TransformSession {
    private _historyMessage : RawChatHistoryMessage;
    private  _intermediateMessages : IntermediateMessage[];
    private _onCompleted : Function;
    private _createdTime : Date;
    private _converted: boolean;

    constructor(historyMessage : Message, onCompleted : Function){
        this._historyMessage = new RawChatHistoryMessage(
            historyMessage.from().id, 
            historyMessage.to().id,
            historyMessage.text()); 

        this._onCompleted = onCompleted || (() => {});
        this._createdTime = new Date();
    }

    start() : void {
        this._intermediateMessages = this.parseAsIntermediateMessages(this._historyMessage.text);
        
        const state = this.getLatestState();
        if(!state.hasMissingItems){
            this.convert();
            this._onCompleted();
            return;
        }

        this.reply(notice.started);
        let msg = '有些内容需要单独传过来：\n';
        for(const key in state.missingItems){
            const count = state.missingItems[key];
            msg += `${count}个${key}\n`;
        }
        msg += '请按顺序提供这些内容，如果不想提供，请回复“直接转换”或“取消”。';
        this.reply(msg);
    }

    newMessageArrived(message : Message) : void {
        if(message.type() === MessageType.Text){
            switch (message.text()){
                case '直接转换':
                    this.convert();
                    return;
                case '取消':
                    this._onCompleted();
                    return;
                default:
                    const msg = '请按顺序提供内容，如果不想提供，请回复“直接转换”或“取消”。';
                    this.reply(msg);
                    return;
            }
        }

        let acceptedAs : string = '';
        
        const incompleteMessages = this._intermediateMessages.filter(m => m.additionalMessageHanlder != null);
        for(var i=0;i<incompleteMessages.length;i++){
            const msg = incompleteMessages[i];
            const handlerName = msg.additionalMessageHanlder.name;
            if(msg.additionalMessageHanlder.accept(message)){
                acceptedAs = handlerName;
                break;
            }
        }
        
        const currentState = this.getLatestState();
        if(!currentState.hasMissingItems){
            this.convert();
            return;
        }

        if(!!acceptedAs){
            let msg = `收到1个${acceptedAs}，还缺少：`;
            for(const key in currentState.missingItems){
                const count = currentState.missingItems[key];
                msg += `${count}个${key}\n`;
            }
            msg += '请按顺序提供这些内容，如果不想提供，请回复“直接转换”或“取消”。';
            this.reply(msg);
        }else{
            const msg = '请按顺序提供内容，如果不想提供，请回复“直接转换”或“取消”。';
            this.reply(msg);
        }
    }

    private parseAsIntermediateMessages(rawMsgText : string) : IntermediateMessage[]{
        const msgCollection = parseXMLToMsgCollection(rawMsgText);
        const msgItems : any[] = msgCollection.recordinfo.datalist.dataitem;
        
        return msgItems.map(msg => {
            const converter = allConverters.find((c) => {
                const typeVal = parseInt(msg['@'].datatype);
                return c.supportsType(typeVal, msg);
            });

            if(!converter){
                // 不支持的消息，使用文本类型，显示原始提示
                return new TextMessage(msg);
            }

            return converter.convertFromXML(msg);
        });
    }

    private convert() : void {
        if(this._converted){
            return;
        }
        
        const converted : ChatMessage[] = this._intermediateMessages.map(msg => {
            if(!msg.additionalMessageHanlder){
                return msg.getConvertedMessage();
            }else{
                const skipped = IntermediateMessage.buildMetaMessage(msg.originalXMLObject);
                skipped.content = new TextChatMessageContent(`[${msg.additionalMessageHanlder.name}]`);
                return skipped;
            }
        });

        this._converted = true;
        const chatId = ChatStore.store(this._historyMessage.fromId, converted);
        this.reply(notice.completed + '\n会话 Id:' + chatId);
        this._onCompleted();
    }

    private getLatestState() : ConvertState{
        const incompleteMessages = this._intermediateMessages.filter(m => m.additionalMessageHanlder != null);
        const stat : any = {};
        incompleteMessages.forEach((cur)=> {
            const handlerName = cur.additionalMessageHanlder.name;
            stat[handlerName] = (stat[handlerName] || 0) + 1;
        });

        return {
            hasMissingItems: incompleteMessages.length > 0,
            missingItems: stat
        }
    }

    private reply(text) : void {
       BotManager.sendMessageToContact(
           this._historyMessage.toId,
           this._historyMessage.fromId,
           text);
    }


    get createdAt() : Date {
        return this._createdTime;
    }

    get expired() : boolean {
        const sessionExpire = 600 * 1000; // 10 分钟
        
        const timeElapsed = new Date().getTime() - this.createdAt.getTime();
        return timeElapsed > sessionExpire;
    }
}
  