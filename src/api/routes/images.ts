import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { DEFAULT_MODEL, generateImagesWithRetry } from "@/api/controllers/images.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";
import { persistMediaArtifact } from "@/lib/media-storage.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";

function toStringArray(value: unknown): string[] {
  if (_.isUndefined(value) || _.isNull(value)) return [];
  if (_.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  const normalized = String(value || "").trim();
  return normalized ? [normalized] : [];
}

function collectUploadedFilePaths(files: any): string[] {
  const result: string[] = [];
  if (_.isEmpty(files)) return result;

  _.forEach(files, (fileOrFiles) => {
    const list = _.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    list.forEach((file) => {
      const filePath = file?.filepath || file?.path;
      if (filePath) result.push(filePath);
    });
  });

  return result;
}

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.model", v => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", _.isString)
        .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
        .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
        .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("body.filePath", v => _.isUndefined(v) || _.isString(v))
        .validate("body.filePaths", v => _.isUndefined(v) || _.isString(v) || _.isArray(v))
        .validate("body.file_paths", v => _.isUndefined(v) || _.isString(v) || _.isArray(v))
        .validate("body.images", v => _.isUndefined(v) || _.isString(v) || _.isArray(v))
        .validate("headers.authorization", _.isString);
      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      if (tokens.length === 0) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Authorization token is empty");
      }
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);
      const {
        model = DEFAULT_MODEL,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        sample_strength: sampleStrength,
        response_format,
        filePath: bodyFilePath,
        filePaths: bodyFilePaths,
        file_paths: bodyFilePathsSnake,
        images: bodyImages,
      } = request.body;
      
      // 处理文件上传 (multipart/form-data)
      const filePaths = [
        ...toStringArray(bodyFilePath),
        ...toStringArray(bodyFilePaths),
        ...toStringArray(bodyFilePathsSnake),
        ...toStringArray(bodyImages),
      ];
      // @ts-ignore
      const files = request.files || {};
      filePaths.push(...collectUploadedFilePaths(files));

      const responseFormat = _.defaultTo(response_format, "url");
      const imageUrls = await generateImagesWithRetry(model, prompt, {
        ratio,
        resolution,
        sampleStrength,
        negativePrompt,
        filePaths,
      }, token);
      
      // 记录统计和媒体
      try {
        db.recordCall(token, model, 0);
        await Promise.all(imageUrls
          .filter(Boolean)
          .map(url => persistMediaArtifact('image', url, model, prompt, token)));
      } catch (e) {
        // 忽略数据库错误，不影响主流程
      }
      
      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = imageUrls.map((url) => ({
          url,
        }));
      }
      return {
        created: util.unixTimestamp(),
        data,
      };
    },
  },
};
