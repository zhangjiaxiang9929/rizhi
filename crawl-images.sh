#!/bin/bash
# ============================================
# 智能图片爬虫脚本
# 自动抓取帝拓音频网站所有产品图片
# ============================================

echo "============================================"
echo "  帝拓音频网站图片智能爬虫"
echo "============================================"
echo ""

BASE_DIR="ditor-crawled-images"
mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

# 分类页面列表
CATEGORIES=(
    "01-网络广播系统|/a/Product/gonggongguangboxitong/wangluoguangboxitong/"
    "02-智能广播设备|/a/Product/gonggongguangboxitong/zhinenshuziguangbo/"
    "03-天花扬声器|/a/Product/gonggongguangboxitong/tianhuayangshengqi/"
    "04-号角扬声器|/a/Product/gonggongguangboxitong/haojiaoyangshengqi/"
    "05-线阵扬声器|/a/Product/zhuanyeyinxiangxitong/xianzhenyangshengqi/"
    "06-专业音箱|/a/Product/zhuanyeyinxiangxitong/yangshengqi/"
    "07-功率放大器|/a/Product/zhuanyeyinxiangxitong/gonglvfangdaqi/"
    "08-调音台|/a/Product/zhuanyeyinxiangxitong/diaoyintai/"
    "09-会议系统|/a/Product/huiyixitong/huiyiyangshengqixilie/"
    "10-会议主机|/a/Product/huiyixitong/zhuanyeyouxianhuiyixitong/"
    "11-无线话筒|/a/Product/wuxianmaikefeng/wuxianmaikefeng/"
    "12-有线话筒|/a/Product/wuxianmaikefeng/youxianhuiyimaikefeng/"
)

total_images=0

for category_info in "${CATEGORIES[@]}"; do
    IFS='|' read -r category_name category_url <<< "$category_info"
    
    echo ""
    echo "[$category_name] 正在抓取..."
    echo "  URL: https://ditor.cn$category_url"
    
    # 创建目录
    mkdir -p "$category_name"
    
    # 抓取页面并提取图片URL和产品名称
    page_content=$(curl -s "https://ditor.cn$category_url")
    
    # 提取图片URL和alt文本
    images=$(echo "$page_content" | grep -oE 'src="/uploads[^"]*\.jpg"[^>]*alt="[^"]*"' | head -20)
    
    if [ -z "$images" ]; then
        echo "  ⚠ 未找到图片"
        continue
    fi
    
    count=0
    while IFS= read -r img_info; do
        # 提取图片URL
        img_url=$(echo "$img_info" | grep -oE '/uploads[^"]*\.jpg' | head -1)
        # 提取产品名称
        product_name=$(echo "$img_info" | grep -oE 'alt="[^"]*"' | sed 's/alt="//;s/"$//')
        
        if [ -n "$img_url" ] && [ -n "$product_name" ]; then
            # 生成文件名
            filename=$(echo "$product_name" | sed 's/[\/:*?"<>|]/_/g').jpg
            
            # 如果文件名太长，使用原文件名
            if [ ${#filename} -gt 100 ]; then
                filename=$(basename "$img_url")
            fi
            
            echo "  下载: $product_name"
            curl -s -o "$category_name/$filename" "https://ditor.cn$img_url"
            
            if [ $? -eq 0 ]; then
                echo "    ✓ 成功"
                ((count++))
            else
                echo "    ✗ 失败"
            fi
        fi
    done <<< "$images"
    
    echo "  本分类下载: $count 张"
    ((total_images+=count))
    
    # 随机延迟，避免请求过快
    sleep 1
done

echo ""
echo "============================================"
echo "  抓取完成！"
echo "============================================"
echo ""
echo "保存位置: $(pwd)"
echo ""
echo "目录结构:"
ls -la
echo ""
echo "总计下载: $total_images 张图片"
echo ""
echo "各分类图片数量:"
for dir in */; do
    count=$(find "$dir" -type f -name "*.jpg" 2>/dev/null | wc -l)
    echo "  $dir: $count 张"
done
