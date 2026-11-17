# 同频风格审核

打开index.html或运行environment/scripts/preview-designs.ps1。A霁蓝、B暖砂、C石墨、D暮紫，支持聊天/登录四图对照和单套可操作预览。素材为真实客户端DOM/逻辑副本与合成演示数据，所有API由本机内存适配器处理；未接入正式服务或DSH，刷新会丢弃演示输入。

构建：node environment/scripts/build-design-review.mjs。验证截图：environment/venv/Scripts/python.exe environment/scripts/verify-design-review.py。产品client保持已发布版本，确认方向后再实施。
