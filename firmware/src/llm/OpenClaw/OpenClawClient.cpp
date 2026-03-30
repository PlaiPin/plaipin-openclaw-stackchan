#include <Arduino.h>
#include <M5Unified.h>
#include <SPIFFS.h>
#include <Avatar.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "SpiRamJsonDocument.h"
#include "OpenClawClient.h"
#include "../ChatHistory.h"
#include "Robot.h"

using namespace m5avatar;
extern Avatar avatar;

// Strip emoji and decorative symbols from text for TTS compatibility.
// Keeps ASCII, Latin extended, CJK, Hiragana, Katakana, and JP punctuation.
// Strips 4-byte emoji AND 3-byte symbols/dingbats/emoticons.
static String stripEmoji(const String& input) {
  String output;
  output.reserve(input.length());
  const char* p = input.c_str();
  while (*p) {
    uint8_t c = (uint8_t)*p;
    if (c < 0x80) {
      // ASCII — keep
      output += (char)c;
      p++;
    } else if ((c & 0xE0) == 0xC0) {
      // 2-byte UTF-8 — keep (Latin extended, etc.)
      output += (char)p[0];
      output += (char)p[1];
      p += 2;
    } else if ((c & 0xF0) == 0xE0) {
      // 3-byte UTF-8 — decode codepoint and check if it's an emoji/symbol
      uint16_t cp = ((uint16_t)(c & 0x0F) << 12)
                   | ((uint16_t)((uint8_t)p[1] & 0x3F) << 6)
                   | ((uint16_t)((uint8_t)p[2] & 0x3F));
      bool skip = false;
      // Dingbats: U+2700-U+27BF (✂✈✉✊...✨✩...)
      if (cp >= 0x2700 && cp <= 0x27BF) skip = true;
      // Misc Symbols: U+2600-U+26FF (☀☁☂★☆♠♡♢♣...)
      if (cp >= 0x2600 && cp <= 0x26FF) skip = true;
      // Misc Technical emoticons: U+2300-U+23FF (⌚⌛⏰...)
      if (cp >= 0x2300 && cp <= 0x23FF) skip = true;
      // Arrows supplement/misc: U+2190-U+21FF
      // Enclosed alphanumerics: U+2460-U+24FF (①②③...)
      if (cp >= 0x2460 && cp <= 0x24FF) skip = true;
      // Geometric shapes: U+25A0-U+25FF
      if (cp >= 0x25A0 && cp <= 0x25FF) skip = true;
      // Variation selectors: U+FE00-U+FE0F
      if (cp >= 0xFE00 && cp <= 0xFE0F) skip = true;

      if (!skip) {
        output += (char)p[0];
        output += (char)p[1];
        output += (char)p[2];
      }
      p += 3;
    } else if ((c & 0xF8) == 0xF0) {
      // 4-byte UTF-8 — skip (emoji, supplementary symbols)
      p += 4;
    } else {
      p++;
    }
  }
  return output;
}

// Minimal chat template — no functions, no function_call field
static const String json_OpenClawChatString =
"{\"model\": \"openclaw:main\","
  "\"stream\": false,"
  "\"messages\": [{\"role\": \"system\", \"content\": \"\"},"
                  "{\"role\": \"system\", \"content\": \"\"},"
                  "{\"role\": \"system\", \"content\": \"User Info: \"}]"
"}";


OpenClawClient::OpenClawClient(llm_param_t param, openclaw_s ocConfig, int _promptMaxSize)
  : LLMBase(param, _promptMaxSize)
{
  openclaw_host  = ocConfig.host;
  openclaw_port  = ocConfig.port;
  openclaw_model = ocConfig.model;

  enableMemory(false);  // OpenClaw handles memory server-side

  if(promptMaxSize != 0){
    load_role();
  }
  else{
    Serial.println("Prompt buffer is disabled");
  }
}


bool OpenClawClient::init_chat_doc(const char *data)
{
  DeserializationError error = deserializeJson(chat_doc, data);
  if (error) {
    Serial.println("OpenClawClient: DeserializationError");
    String json_str;
    serializeJsonPretty(chat_doc, json_str);
    Serial.println(json_str);
    return false;
  }
  return true;
}


void OpenClawClient::load_role(){
  String role = "";
  String userInfo = "User Info: ";
  String systemRole = systemRole_noMemory;  // Memory handled by OpenClaw server
  Serial.println("OpenClawClient: Load role from SPIFFS.");

  if(load_system_prompt_from_spiffs()){
    role = String((const char*)systemPrompt["messages"][SYSTEM_PROMPT_INDEX_USER_ROLE]["content"]);
    if (role == "") {
      Serial.println("SPIFFS user role is empty. set default role.");
      role = defaultRole;
    }

    userInfo = String((const char*)systemPrompt["messages"][SYSTEM_PROMPT_INDEX_USER_INFO]["content"]);
    int idx = userInfo.indexOf("User Info");
    if(idx < 0){
      userInfo = "User Info: ";
    }
  }else{
    role = defaultRole;
    userInfo = "User Info: ";
  }

  init_chat_doc(json_OpenClawChatString.c_str());

  // Override the model field from config
  chat_doc["model"] = openclaw_model;

  chat_doc["messages"][SYSTEM_PROMPT_INDEX_USER_ROLE]["content"] = role;
  chat_doc["messages"][SYSTEM_PROMPT_INDEX_SYSTEM_ROLE]["content"] = systemRole;
  chat_doc["messages"][SYSTEM_PROMPT_INDEX_USER_INFO]["content"] = userInfo;

  serializeJson(chat_doc, InitBuffer);
  String json_str;
  serializeJsonPretty(chat_doc, json_str);
  Serial.println("OpenClawClient: Initialized prompt:");
  Serial.println(json_str);
}


// TODO: Add TLS support for production use
String OpenClawClient::http_post_json(const char* url, const char* json_string) {
  String payload = "";
  HTTPClient http;
  http.setTimeout(65000);

  Serial.print("[HTTP] begin...\n");
  if (http.begin(url)) {
    Serial.print("[HTTP] POST...\n");
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + param.api_key);
    int httpCode = http.POST((uint8_t *)json_string, strlen(json_string));

    if (httpCode > 0) {
      Serial.printf("[HTTP] POST... code: %d\n", httpCode);
      if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_MOVED_PERMANENTLY) {
        payload = http.getString();
        Serial.println("//////////////");
        Serial.println(payload);
        Serial.println("//////////////");
      }
    } else {
      Serial.printf("[HTTP] POST... failed, error: %s\n", http.errorToString(httpCode).c_str());
    }
    http.end();
  } else {
    Serial.printf("[HTTP] Unable to connect\n");
  }
  return payload;
}


void OpenClawClient::chat(String text, const char *base64_buf) {
  static String response = "";

  // Add user question to chat history
  chatHistory.push_back(String("user"), String(""), text);

  // Reinitialize chat_doc from template
  init_chat_doc(InitBuffer.c_str());

  // Append chat history to messages array
  for (int i = 0; i < chatHistory.get_size(); i++)
  {
    JsonArray messages = chat_doc["messages"];
    JsonObject msg = messages.createNestedObject();
    msg["role"] = chatHistory.get_role(i);
    msg["content"] = chatHistory.get_content(i);
  }

  // Serialize and send
  String json_string;
  serializeJson(chat_doc, json_string);

  Serial.println("====================");
  Serial.println(json_string);
  Serial.println("====================");

  // Build URL: http://<host>:<port>/v1/chat/completions
  String url = String("http://") + openclaw_host + ":" + String(openclaw_port) + "/v1/chat/completions";

  avatar.setExpression(Expression::Doubt);
  avatar.setSpeechFont(&fonts::efontJA_16);
  avatar.setSpeechText("考え中…");

  String ret = http_post_json(url.c_str(), json_string.c_str());

  avatar.setExpression(Expression::Neutral);
  avatar.setSpeechText("");

  Serial.println(ret);

  // Defensive response parsing
  if(ret == ""){
    // Connection error
    avatar.setExpression(Expression::Sad);
    avatar.setSpeechFont(&fonts::efontJA_16);
    avatar.setSpeechText("接続エラー");
    response = "接続エラー";
    delay(1000);
    avatar.setSpeechText("");
    avatar.setExpression(Expression::Neutral);
  }
  else{
    DynamicJsonDocument doc(2000);
    DeserializationError error = deserializeJson(doc, ret.c_str());
    if (error) {
      Serial.print(F("deserializeJson() failed: "));
      Serial.println(error.f_str());
      avatar.setExpression(Expression::Sad);
      avatar.setSpeechText("パースエラー");
      response = "パースエラー";
      delay(1000);
      avatar.setSpeechText("");
      avatar.setExpression(Expression::Neutral);
    }
    else if(doc.containsKey("error")){
      // API returned an error object
      const char* errMsg = doc["error"]["message"];
      Serial.printf("OpenClaw API error: %s\n", errMsg ? errMsg : "unknown");
      avatar.setExpression(Expression::Sad);
      avatar.setSpeechText("APIエラー");
      response = "APIエラー";
      delay(1000);
      avatar.setSpeechText("");
      avatar.setExpression(Expression::Neutral);
    }
    else if(!doc["choices"][0]["message"].containsKey("content")){
      Serial.println("OpenClaw: missing content in response");
      avatar.setExpression(Expression::Sad);
      avatar.setSpeechText("応答エラー");
      response = "応答エラー";
      delay(1000);
      avatar.setSpeechText("");
      avatar.setExpression(Expression::Neutral);
    }
    else{
      const char* data = doc["choices"][0]["message"]["content"];
      if(data == nullptr){
        Serial.println("OpenClaw: null content in response");
        response = "応答が空です";
      }
      else{
        response = stripEmoji(String(data));
        std::replace(response.begin(), response.end(), '\n', ' ');
      }
    }
  }

  // Add assistant response to history and speak
  chatHistory.push_back(String("assistant"), String(""), response);
  robot->speech(response);
}
