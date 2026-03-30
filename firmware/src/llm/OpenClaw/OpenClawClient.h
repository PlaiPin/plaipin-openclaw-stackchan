#ifndef _OPENCLAW_CLIENT_H
#define _OPENCLAW_CLIENT_H

#include <Arduino.h>
#include <M5Unified.h>
#include "StackchanExConfig.h"
#include "SpiRamJsonDocument.h"
#include "../ChatHistory.h"
#include "../LLMBase.h"

#define OPENCLAW_PROMPT_MAX_SIZE   (1024*50)

class OpenClawClient: public LLMBase{
public:
    String openclaw_host;
    int    openclaw_port;
    String openclaw_model;

public:
    OpenClawClient(llm_param_t param, openclaw_s ocConfig, int _promptMaxSize = OPENCLAW_PROMPT_MAX_SIZE);
    virtual void chat(String text, const char *base64_buf = NULL);
    String http_post_json(const char* url, const char* json_string);

    virtual bool init_chat_doc(const char *data);
    virtual void load_role();
};

#endif  //_OPENCLAW_CLIENT_H
