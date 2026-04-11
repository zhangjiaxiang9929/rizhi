#!/bin/bash
# ============================================
# 帝拓音频网站深度爬虫
# 自动抓取所有子分类和分页产品
# ============================================

BASE_URL="https://ditor.cn"
OUTPUT_DIR="ditor-deep-crawl"
mkdir -p "$OUTPUT_DIR"

echo "============================================"
echo "  帝拓音频深度爬虫"
echo "============================================"
echo ""

# 定义子分类列表
# 格式: "文件夹名|路径"
SUBCATEGORIES=(
    # 公共广播系统
    "01-网络广播系统|/a/Product/gonggongguangboxitong/wangluoguangboxitong/"
    "02-智能广播设备|/a/Product/gonggongguangboxitong/zhinenshuziguangbo/"
    "03-天花扬声器|/a/Product/gonggongguangboxitong/tianhuayangshengqi/"
    "04-室内外音柱|/a/Product/gonggongguangboxitong/shinawaiyinzhu/"
    "05-号角扬声器|/a/Product/gonggongguangboxitong/haojiaoyangshengqi/"
    "06-壁挂扬声器|/a/Product/gonggongguangboxitong/biguayangshengqi/"
    "07-草地扬声器|/a/Product/gonggongguangboxitong/caodi_yishuyangshengqi/"
    "08-传统广播设备|/a/Product/gonggongguangboxitong/chuantongguangboshebei/"
    
    # 专业音响系统
    "09-线阵扬声器|/a/Product/zhuanyeyinxiangxitong/xianzhenyangshengqi/"
    "10-专业音箱|/a/Product/zhuanyeyinxiangxitong/yangshengqi/"
    "11-功率放大器|/a/Product/zhuanyeyinxiangxitong/gonglvfangdaqi/"
    "12-调音台|/a/Product/zhuanyeyinxiangxitong/diaoyintai/"
    "13-周边设备|/a/Product/zhuanyeyinxiangxitong/zhoubianshebei/"
    
    # 会议系统
    "14-会议扬声器|/a/Product/huiyixitong/huiyiyangshengqixilie/"
    "15-无线会议系统|/a/Product/huiyixitong/wuxianhuiyixitong/"
    
    # 话筒系列
    "16-U段无线麦|/a/Product/wuxianmaikefeng/Uduanwuxianmai/"
)

total_products=0
total_images=0

for item in "${SUBCATEGORIES[@]}"; do
    IFS='|' read -r folder path <<< "$item"
    
    echo ""
    echo "[$folder] 正在抓取..."
    
    # 创建目录
    mkdir -p "$OUTPUT_DIR/$folder"
    
    # 获取产品列表
    page_content=$(curl -s "$BASE_URL$path")
    
    # 提取产品名称和图片URL
    products=$(echo "$page_content" | grep -oE 'title="[^"]*"[^>]*src="/uploads[^"]*"' | head -20)
    
    if [ -z "$products" ]; then
        echo "  ⚠ 未找到产品"
        continue
    fi
    
    count=0
    img_count=0
    
    while IFS= read -r line; do
        # 提取产品名
        product_name=$(echo "$line" | grep -oE 'title="[^"]*"' | sed 's/title="//;s/"$//')
        # 提取图片URL
        img_url=$(echo "$line" | grep -oE 'src="[^"]*"' | sed 's/src="//;s/"$//')
        
        if [ -n "$product_name" ]; then
            echo "  产品: $product_name"
            ((count++))
            
            # 保存产品信息到文本文件
            echo "$product_name" >> "$OUTPUT_DIR/$folder/产品列表.txt"
            
            # 下载图片
            if [ -n "$img_url" ]; then
                filename=$(basename "$img_url")
                if [ ! -f "$OUTPUT_DIR/$folder/$filename" ]; then
                    curl -s -o "$OUTPUT_DIR/$folder/$filename" "$BASE_URL$img_url"
                    if [ $? -eq 0 ]; then
                        echo "    ✓ 图片: $filename"
                        ((img_count++))
                    fi
                fi
            fi
        fi
    done <<< "$products"
    
    echo "  抓取完成: $count 个产品, $img_count 张图片"
    ((total_products+=count))
    ((total_images+=img_count))
    
    # 延迟1秒，避免请求过快
    sleep 1
done

echo ""
echo "============================================"
echo "  深度爬虫完成！"
echo "============================================"
echo ""
echo "保存位置: $(pwd)/$OUTPUT_DIR"
echo ""
echo "统计信息:"
echo "  总产品数: $total_products"
echo "  总图片数: $total_images"
echo ""
echo "目录结构:"
find "$OUTPUT_DIR" -type d | head -20
echo ""
