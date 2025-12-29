以下是可用的API端点，你可以直接在我们的演示站点上测试：[https://api-foward.vercel.app](https://api-foward.vercel.app)

### 通用转发

```http
GET /forward?url=https://api-endpoint.com
```

这个端点会将请求转发到指定的URL，并尝试从响应中提取图片URL，然后通过重定向方式返回。

```http
GET /forward?url=https://api-endpoint.com&field=image
```

如果API返回的JSON中图片URL不是存储在`url`字段中，而是其他字段（如`image`、`img`、`src`等），可以通过`field`参数指定。

### AI绘图

```http
GET /flux?tags=beautiful,landscape
```

使用Flux模型生成图片（2D风格），标签用逗号分隔。

![Flux模型示例](https://api-foward.vercel.app/flux?tags=beautiful,landscape)


```http
GET /turbo?tags=beautiful,landscape
```


使用Turbo模型生成图片（3D风格），标签用逗号分隔。

### 二次元图片

```http
GET /anime1
```

![随机二次元图片1](https://api-foward.vercel.app/anime1)

随机二次元图片1。

```http
GET /anime2
```

![随机二次元图片2](https://api-foward.vercel.app/anime2)

随机二次元图片2。

```http
GET /ba
```

![蓝档案图片](https://api-foward.vercel.app/ba)

蓝档案图片。

```http
GET /anime-tag?keyword=genshinimpact
```

![原神图片](https://api-foward.vercel.app/anime-tag?keyword=genshinimpact)

指定关键词的二次元图片。支持的关键词有：`azurlane`，`genshinimpact`，`arknights`，`honkai`，`fate`，`frontline`，`princess`，`idolmaster`，`hololive`，`touhou`。

```http
GET /anime-tag?keyword=azurlane&size=original&r18=0
```

可选参数：`size`（original/regular/small），`r18`（0/1）。

### 三次元图片

```http
GET /baisi
```

![白丝图片](https://api-foward.vercel.app/baisi)

白丝图片。

```http
GET /heisi
```

![黑丝图片](https://api-foward.vercel.app/heisi)

黑丝图片。

### 表情包

```http
GET /doro
```

![doro.asia随机贴纸](https://api-foward.vercel.app/doro)

doro.asia的随机贴纸。

```http
GET /maomao
```

![柴郡表情包](https://api-foward.vercel.app/maomao)

柴郡表情包。

```http
GET /nailong
```

![奶龙表情包](https://api-foward.vercel.app/nailong)

奶龙表情包。

## 使用示例

获取随机贴纸：

```http
https://api-foward.vercel.app/doro
```

转发请求到其他API：

```http
https://api-foward.vercel.app/forward?url=https://www.doro.asia/api/random-sticker
```

指定自定义字段名：

```http
https://api-foward.vercel.app/forward?url=https://some-api.com/image-api&field=imageUrl
```

## 在HTML中使用

```html
<!-- 使用在线版本 -->
<img src="https://api-foward.vercel.app/doro" alt="随机贴纸">

<!-- 或者使用本地版本 -->
<img src="http://localhost:3000/doro" alt="随机贴纸">
```


## GitHub仓库

```text
https://github.com/ziyi233/api-foward.git
```

