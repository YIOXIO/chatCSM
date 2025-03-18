const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
    entry: {
        main: './src/index.js'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'main.js',
        publicPath: ''
    },

    mode: 'development', // Режим development отключает минификацию по умолчанию
    devServer: {
        static: path.resolve(__dirname, './dist'),
        compress: true,
        port: 8080,
        open: true
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                use: 'babel-loader',
                exclude: '/node_modules'
            },
            {
                // Обработка изображений, шрифтов и других ассетов
                test: /\.(png|svg|jpg|webp|gif|woff(2)?|eot|ttf|otf|pptx)$/,
                type: 'asset/resource',
                generator: {
                    filename: (pathData) => {
                        // Разделяем файлы по папкам
                        if (pathData.filename.includes('.svg')) {
                            return 'svg/[name][ext]'; // SVG в папку svg
                        } else if (pathData.filename.match(/\.(woff2?|eot|ttf|otf)$/)) {
                            return 'fonts/[name][ext]'; // Шрифты в папку fonts
                        } else {
                            return 'img/[name][ext]'; // Остальные изображения в папку img
                        }
                    }
                }
            },
            {
                test: /\.css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    {
                        loader: 'css-loader',
                        options: {
                            importLoaders: 1
                        }
                    },
                    'postcss-loader'
                ]
            },
        ]
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './src/index.html',
            minify: false // Отключаем минификацию HTML
        }),
        new CleanWebpackPlugin(),
        new MiniCssExtractPlugin({
            filename: 'styles.css' // Убираем хеширование в имени CSS-файла
        }),
    ],
    optimization: {
        minimize: false // Отключаем минификацию JavaScript
    }
};